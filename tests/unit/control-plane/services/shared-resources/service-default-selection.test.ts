import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {expect, it} from 'vitest';
import {splitPostgresSqlStatements} from '../../../../../src/api/persistence/postgres-sql-statements';
import {selectAndPinServiceBinding} from '../../../../../src/api/control-plane/repositories/services/service-binding-selection';

it('selects defaults deterministically, pins exact authority and never falls back after denial', async () => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE TABLE teams(id text PRIMARY KEY); CREATE TABLE users(id text PRIMARY KEY);
      INSERT INTO teams VALUES ('team'),('owner');
      CREATE TABLE projects(id text PRIMARY KEY,team_id text NOT NULL);
      INSERT INTO projects VALUES ('project','team');
      CREATE TABLE team_service_connections(id text PRIMARY KEY,team_id text NOT NULL);
      INSERT INTO team_service_connections VALUES ('team-choice','team'),('org-choice','owner'),('deployment-choice','team'),('explicit','team');`);
    for (const migration of ['0013_organizations','0014_vault_registry','0015_shared_resource_grants','0016_service_defaults'])
      for (const statement of splitPostgresSqlStatements(readFileSync(`drizzle/control-plane/${migration}.sql`,'utf8')))
        await db.exec(statement);
    await db.exec(`INSERT INTO organizations(id,name) VALUES ('org','Organization');
      INSERT INTO organization_teams(team_id,organization_id) VALUES ('team','org'),('owner','org');
      INSERT INTO service_default_policies(id,scope,team_id,organization_id,capability,environment,connection_id,status)
      VALUES ('t','team','team',NULL,'read','staging','team-choice','active'),
      ('o','organization',NULL,'org','read','staging','org-choice','active'),
      ('d','deployment',NULL,NULL,'read','staging','deployment-choice','active');
      INSERT INTO shared_resource_grants
        (id,connection_id,owner_team_id,recipient_team_id,organization_id,origin,permissions,environment,resource_ids,
         max_concurrent_operations,max_operations_per_window,window_seconds,status)
      VALUES ('grant','org-choice','owner','team','org','explicit',ARRAY['read'],'staging',ARRAY['repo'],1,10,60,'active');`);
    const database = {transaction: <T>(run: (tx: any) => Promise<T>) => db.transaction(run)};
    const request = {teamId:'team',projectId:'project',capability:'read',environment:'staging' as const,bindingId:'binding'};
    const visited: string[] = [];
    let denied = false;
    const authority = {
      authorizeProject: async () => {},
      authorizeConnection: async (_tx: any, id: string, pinned: string|null|undefined) => {
        visited.push(id);
        if (denied) throw new Error('access_revoked');
        if (id==='org-choice') return {ownerTeamId:'owner',grantId:pinned===undefined?'grant':pinned};
        return {ownerTeamId:'team',grantId:null};
      },
    };
    const select = (overrides = {}) => selectAndPinServiceBinding(database,{...request,...overrides},authority);
    await expect(db.exec(`INSERT INTO service_default_policies(id,scope,team_id,capability,environment,connection_id,status)
      VALUES ('duplicate','team','team','read','staging','explicit','active')`)).rejects.toThrow();
    const initial = await select();
    expect(initial.created).toBe(true);
    expect(initial.binding.connection_id).toBe('team-choice');
    await db.exec("UPDATE service_default_policies SET connection_id='explicit' WHERE id='t'");
    expect((await select()).binding.connection_id).toBe('team-choice');
    expect((await select({explicitConnectionId:'explicit'})).created).toBe(false);
    denied=true; visited.length=0;
    await expect(select()).rejects.toThrow('access_revoked');
    expect(visited).toEqual(['team-choice']);
    denied=false;
    await db.exec("DELETE FROM project_service_bindings; UPDATE service_default_policies SET status='inactive' WHERE id='t'");
    expect((await select()).binding.grant_id).toBe('grant');
    await expect(selectAndPinServiceBinding(database,request,{...authority,
      authorizeConnection:async () => ({ownerTeamId:'owner',grantId:'replacement'})})).rejects.toThrow('pinned_service_authority_changed');
    await db.exec('DELETE FROM project_service_bindings');
    denied=true; visited.length=0;
    await expect(select()).rejects.toThrow('access_revoked');
    expect(visited).toEqual(['org-choice']);
    expect((await db.query('SELECT * FROM project_service_bindings')).rows).toEqual([]);
    denied=false;
    await db.exec("UPDATE service_default_policies SET status='inactive' WHERE id='o'");
    expect((await select()).binding.connection_id).toBe('deployment-choice');
    await db.exec('DELETE FROM project_service_bindings');
    expect((await select({explicitConnectionId:'explicit'})).binding.connection_id).toBe('explicit');
    await db.exec('DELETE FROM project_service_bindings');
    await expect(selectAndPinServiceBinding(database,request,{...authority,
      authorizeProject:async () => {throw new Error('actor_denied');}})).rejects.toThrow('actor_denied');
    await expect(select({teamId:'owner'})).rejects.toThrow('project_unavailable');
    await expect(db.exec(`INSERT INTO project_service_bindings
      VALUES ('forged','team','project','read','staging','org-choice','owner',NULL,1)`)).rejects.toThrow();
    await expect(db.exec(`INSERT INTO project_service_bindings
      VALUES ('forged','owner','project','read','staging','org-choice','owner',NULL,1)`)).rejects.toThrow('service_binding_owner_mismatch');
    await db.exec("UPDATE service_default_policies SET status='inactive'");
    await expect(select()).rejects.toThrow('service_binding_unavailable');
  } finally {await db.close();}
},15000);
