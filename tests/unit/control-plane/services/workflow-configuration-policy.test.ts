import {describe,it,expect,vi} from 'vitest';
import {workflowConfigurationNames,requireWorkflowConfigurationName} from '../../../../src/security/workflow-configuration-policy.ts';
import {permissionScope} from '../../../../src/security/provider-credential-authority.ts';
import {createWorkflowConfigurationService} from '../../../../src/api/control-plane/repositories/workflow-configuration-service.ts';
const target={repositoryBindingId:'repository',kind:'secrets' as const,scope:'environment',environment:'staging'};
const policy={workflowConfiguration:[{...target,workflowPath:'.github/workflows/release.yml',names:['DEPLOY_TOKEN']}]};
describe('workflow configuration authority',()=>{
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
