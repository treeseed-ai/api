import {describe,it,expect,vi} from 'vitest';
import {workflowConfigurationNames,requireWorkflowConfigurationName} from '../../../../src/security/workflow-configuration-policy.ts';
import {permissionScope} from '../../../../src/security/provider-credential-authority.ts';
import {createWorkflowConfigurationService} from '../../../../src/api/control-plane/repositories/workflow-configuration-service.ts';
import {createWorkflowService,serializeWorkflowOperation} from '../../../../src/api/control-plane/repositories/workflow-service.ts';
import {ControlPlaneStore} from '../../../../src/api/persistence/store.ts';
import {postgresGraph} from '../capacity/execution/graph/architecture/living/living-postgres-fixture.ts';
const target={repositoryBindingId:'repository',kind:'secrets' as const,scope:'environment',environment:'staging'};
const policy={workflowConfiguration:[{...target,workflowPath:'.github/workflows/release.yml',names:['DEPLOY_TOKEN']}]};
describe('workflow configuration authority',()=>{
  it('execution workflow configuration refuses missing owning read-back before successful audit and keeps exact retry inputs',async()=>{
    const body={repositoryBindingId:'repository',workflowBindingId:'workflow',workflowId:'.github/workflows/verify.yml',
      refPolicy:['refs/heads/staging'],actorPolicy:['capacity_provider'],modePolicy:['acting'],allowedInputs:{},requiredSecrets:[],requiredVariables:[]};
    const before=structuredClone(body),principal={id:'operator',roles:['admin']};
    const store={getProjectDetails:vi.fn(async()=>({project:{id:'project',teamId:'team'}})),
      first:vi.fn().mockResolvedValueOnce({id:'repository',service_connection_id:'connection'})
        .mockResolvedValueOnce({id:'workflow',connection_id:'connection'}).mockResolvedValueOnce(null).mockResolvedValueOnce(null),
      run:vi.fn(async()=>undefined),recordAuditEvent:vi.fn(async()=>undefined)};
    await expect(createWorkflowService(store).update(principal,'project','operation',body,'0')).rejects.toMatchObject({
      status:503,code:'workflow_operation_readback_missing',message:'Workflow operation could not be read back.'});
    expect(store.run).toHaveBeenCalledTimes(1);expect(store.recordAuditEvent).not.toHaveBeenCalled();expect(body).toEqual(before);
    const row={id:'operation',project_id:'project',team_id:'team',workflow_binding_id:'workflow',repository_binding_id:'repository',
      workflow_id:body.workflowId,version:1};
    store.first.mockResolvedValueOnce({id:'repository',service_connection_id:'connection'})
      .mockResolvedValueOnce({id:'workflow',connection_id:'connection'}).mockResolvedValueOnce(null).mockResolvedValueOnce(row);
    await expect(createWorkflowService(store).update(principal,'project','operation',body,'0')).resolves.toEqual(serializeWorkflowOperation(row));
    expect(store.run).toHaveBeenCalledTimes(2);expect(store.recordAuditEvent).toHaveBeenCalledExactlyOnceWith({
      eventType:'workflow.operation.configured',actorType:'user',actorId:'operator',targetType:'project_workflow_operation',targetId:'operation',
      data:{projectId:'project',teamId:'team',workflowId:body.workflowId,repositoryBindingId:'repository',workflowBindingId:'workflow'}});
    expect(body).toEqual(before);
  });
  it('native execution workflow configuration retains interrupted PostgreSQL authority without false successful audit before independent exact retry',async()=>{
    const f=await postgresGraph();
    try{
      const store=new ControlPlaneStore({TREESEED_ENVIRONMENT:'test'},f.left);store.initializationPromise=Promise.resolve();
      const now='2026-10-06T00:00:00.000Z';
      await f.left.pool.query(`INSERT INTO projects(id,team_id,slug,name,created_at,updated_at) VALUES('project','team','execution','Execution',$1,$1)`,[now]);
      await f.left.pool.query(`INSERT INTO team_service_capability_bindings(id,team_id,connection_id,capability_type,created_at,updated_at)
        VALUES('workflow','team','connection','workflow-execution',$1,$1)`,[now]);
      await f.left.pool.query(`INSERT INTO project_remote_repository_bindings(id,project_id,team_id,service_connection_id,capability_binding_id,
        provider_id,provider_repository_id,owner,name,clone_url,default_ref,publication_ref,authority_id,created_at,updated_at)
        VALUES('repository','project','team','connection','workflow','github','external-repository','example','execution',
        'https://github.com/example/execution.git','refs/heads/main','refs/heads/staging','authority',$1,$1)`,[now]);
      const body={repositoryBindingId:'repository',workflowBindingId:'workflow',workflowId:'.github/workflows/verify.yml',
        refPolicy:['refs/heads/staging'],actorPolicy:['capacity_provider'],modePolicy:['acting'],allowedInputs:{},requiredSecrets:[],requiredVariables:[]},before=structuredClone(body);
      const bindings=async()=>({repositories:(await f.right.pool.query('SELECT * FROM project_remote_repository_bindings ORDER BY id')).rows,
        workflows:(await f.right.pool.query('SELECT * FROM team_service_capability_bindings ORDER BY id')).rows});
      const baseline=await bindings();
      await f.left.pool.query(`CREATE FUNCTION interrupted_workflow_readback() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN NEW.id := 'interrupted-' || NEW.id; RETURN NEW; END $$;
        CREATE TRIGGER interrupted_workflow_readback BEFORE INSERT ON project_workflow_operations FOR EACH ROW EXECUTE FUNCTION interrupted_workflow_readback()`);
      const service=createWorkflowService(store);
      await expect(service.update(f.principal,'project','operation',body,'0')).rejects.toMatchObject({
        status:503,code:'workflow_operation_readback_missing',message:'Workflow operation could not be read back.'});
      const failed=(await f.right.pool.query('SELECT * FROM project_workflow_operations ORDER BY id')).rows;
      expect(failed).toHaveLength(1);expect(failed[0]).toMatchObject({id:'interrupted-operation',project_id:'project',team_id:'team',version:1});
      expect((await f.right.pool.query('SELECT * FROM audit_events')).rows).toEqual([]);expect(await bindings()).toEqual(baseline);
      await f.left.pool.query('DROP TRIGGER interrupted_workflow_readback ON project_workflow_operations; DROP FUNCTION interrupted_workflow_readback()');
      const result=await service.update(f.principal,'project','operation',body,'0');
      const rows=(await f.right.pool.query('SELECT * FROM project_workflow_operations ORDER BY id')).rows;
      expect(rows).toHaveLength(2);expect(rows).toContainEqual(failed[0]);
      const saved=rows.find(row=>row.id==='operation');expect(saved).toBeDefined();expect(result).toEqual(serializeWorkflowOperation(saved));
      expect(saved).toMatchObject({workflow_id:body.workflowId,workflow_binding_id:'workflow',repository_binding_id:'repository',version:1,
        ref_policy_json:JSON.stringify(body.refPolicy),actor_policy_json:JSON.stringify(body.actorPolicy),mode_policy_json:JSON.stringify(body.modePolicy)});
      const audits=(await f.right.pool.query('SELECT * FROM audit_events ORDER BY id')).rows;
      expect(audits).toHaveLength(1);expect(audits[0]).toMatchObject({event_type:'workflow.operation.configured',target_id:'operation',actor_id:'operator'});
      expect(JSON.parse(audits[0].data_json)).toEqual({projectId:'project',teamId:'team',workflowId:body.workflowId,repositoryBindingId:'repository',workflowBindingId:'workflow'});
      expect(await bindings()).toEqual(baseline);expect(body).toEqual(before);
      expect(await f.snapshot()).toEqual({nodes:[],edges:[],revisions:[],assignments:[],reservations:[]});
    }finally{await f.close();}
  });
  it('does not turn execution authority into configuration authority',()=>{
    expect(workflowConfigurationNames({},target)).toEqual([]);
    expect(()=>requireWorkflowConfigurationName({},target,'DEPLOY_TOKEN')).toThrow();
    expect(permissionScope('github-workflow-app')).toEqual({actions:'write',contents:'read'});
    expect(permissionScope('github-workflow-app','secrets')).toEqual({actions:'write',contents:'read',secrets:'write'});
    expect(permissionScope('github-workflow-app','variables')).toEqual({actions:'write',contents:'read',variables:'write'});
    expect(permissionScope('github-workflow-app','secrets','environment')).toEqual({actions:'write',contents:'read',environments:'write'});
    expect(workflowConfigurationNames('{invalid',target)).toEqual([]);
  });
  it('limits delivery to exact declared names, repository, kind and environment',()=>{
    expect(workflowConfigurationNames(policy,target)).toEqual(['DEPLOY_TOKEN']);
    expect(()=>requireWorkflowConfigurationName(policy,target,'OTHER_TOKEN')).toThrow();
    for(const change of [{repositoryBindingId:'other'},{kind:'variables' as const},{environment:'production'},{scope:'organization'}])
      expect(workflowConfigurationNames(policy,{...target,...change})).toEqual([]);
  });
  it('rechecks changed policy and rejects wildcards',()=>{
    expect(()=>requireWorkflowConfigurationName(policy,target,'DEPLOY_TOKEN')).not.toThrow();
    expect(()=>requireWorkflowConfigurationName({...policy,workflowConfiguration:[]},target,'DEPLOY_TOKEN')).toThrow();
    expect(workflowConfigurationNames({workflowConfiguration:[{...policy.workflowConfiguration[0],names:['*']}]},target)).toEqual([]);
  });
  it('denies undeclared API writes before resolving credentials or queueing delivery',async()=>{
    const store={getProjectDetails:vi.fn(async()=>({project:{teamId:'team'}})),
      first:vi.fn().mockResolvedValueOnce({id:'repository',provider_id:'github',team_id:'team',service_connection_id:'connection'})
        .mockResolvedValueOnce({id:'workflow',connection_id:'connection',credential_profile_id:'github-workflow-app',configuration_json:'{}'})
        .mockResolvedValueOnce({id:'authority'}),run:vi.fn()};
    await expect(createWorkflowConfigurationService(store).put({id:'admin',roles:['admin']},'project','variables','OTHER',{repositoryBindingId:'repository',workflowBindingId:'workflow'},{value:'fixture'},'request','0')).rejects.toMatchObject({status:403,code:'workflow_configuration_not_declared'});
    expect(store.run).not.toHaveBeenCalled();expect(store.first).toHaveBeenCalledTimes(3);
  });
});
