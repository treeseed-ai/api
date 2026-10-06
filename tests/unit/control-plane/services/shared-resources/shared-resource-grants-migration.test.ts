import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {expect, it} from 'vitest';
import {splitPostgresSqlStatements} from '../../../../../src/api/persistence/postgres-sql-statements';
import {reserveSharedResourceOperation} from '../../../../../src/api/control-plane/repositories/services/shared-resource-reservations';
import {revokeOwnedSharedGrant} from '../../../../../src/api/control-plane/repositories/services/shared-resource-management';

it('isolates grant kinds and revokes access for departing owners and recipients without hiding in-flight work', async () => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE TABLE teams(id text PRIMARY KEY,status text DEFAULT 'active');
      CREATE TABLE users(id text PRIMARY KEY,status text DEFAULT 'active');
      INSERT INTO teams(id) VALUES ('owner'),('one'),('two'),('outsider');
      INSERT INTO users(id) VALUES ('manager');
      CREATE TABLE team_memberships(id text PRIMARY KEY,team_id text,user_id text,status text);
      CREATE TABLE team_role_bindings(id text PRIMARY KEY,team_membership_id text,role_id text);
      CREATE TABLE roles(id text PRIMARY KEY,key text);
      INSERT INTO roles VALUES ('admin-role','service_admin');
      INSERT INTO team_memberships VALUES ('member','owner','manager','active');
      INSERT INTO team_role_bindings VALUES ('role-binding','member','admin-role');
      CREATE TABLE team_service_connections(id text PRIMARY KEY,team_id text NOT NULL REFERENCES teams(id));
      INSERT INTO team_service_connections VALUES ('connection','owner');`);
    for (const migration of ['0013_organizations','0014_vault_registry','0015_shared_resource_grants'])
      for (const statement of splitPostgresSqlStatements(readFileSync(`drizzle/control-plane/${migration}.sql`,'utf8')))
        await db.exec(statement);
    await db.exec(`INSERT INTO organizations(id,name) VALUES ('org','Organization'),('other','Other');
      INSERT INTO organization_teams(team_id,organization_id) VALUES ('owner','org'),('one','org'),('two','org'),('outsider','other');
      INSERT INTO vault_registrations
      (id,owner_team_id,display_name,backend,endpoint,secrets_mount,network_route_id,tls_trust_id,auth_mount,role_id,bootstrap_credential_ref)
      VALUES ('vault','owner','Vault','managed-openbao','https://vault.example.test','treeseed','route','trust','approle','role','bootstrap');`);
    const grant = (id: string, recipient: string, kind='connection', owner='owner') => db.query(`INSERT INTO shared_resource_grants
      (id,connection_id,vault_id,owner_team_id,recipient_team_id,organization_id,origin,permissions,environment,resource_ids,
      max_concurrent_operations,max_operations_per_window,window_seconds,status)
      VALUES ($1,$2,$3,$4,$5,'org','explicit',ARRAY['read'],'staging',ARRAY['repository'],1,10,60,'active')`,
    [id,kind==='connection'?'connection':null,kind==='vault'?'vault':null,owner,recipient]);
    expect((await db.query('SELECT * FROM shared_resource_grants')).rows).toEqual([]);
    await expect(grant('cross','outsider')).rejects.toThrow('shared_resource_organization_mismatch');
    await expect(grant('forged','one','connection','two')).rejects.toThrow('shared_resource_owner_mismatch');
    await grant('g1','one'); await grant('g2','two'); await grant('v1','one','vault');
    const database = {transaction: <T>(run: (tx: any) => Promise<T>) => db.transaction(run)};
    const reserve = (key: string, authorize = async () => {}) => reserveSharedResourceOperation(database,
      {grantId:'g2',operationKey:key,reservationId:`reservation-${key}`},authorize);
    await expect(reserve('denied',async () => {throw new Error('scope_denied');})).rejects.toThrow('scope_denied');
    expect((await db.query('SELECT * FROM shared_resource_operation_reservations')).rows).toEqual([]);
    expect(await reserve('first')).toEqual({reservationId:'reservation-first',status:'active',created:true});
    expect(await reserve('first')).toEqual({reservationId:'reservation-first',status:'active',created:false});
    await expect(reserve('first',async () => {throw new Error('authority_revoked');})).rejects.toThrow('authority_revoked');
    await db.exec("UPDATE shared_resource_grants SET expires_at=now()-interval '1 second' WHERE id='g2'");
    await expect(reserve('first')).rejects.toThrow('shared_grant_inactive');
    await db.exec("UPDATE shared_resource_grants SET expires_at=NULL WHERE id='g2'");
    await expect(reserve('second')).rejects.toThrow('shared_grant_concurrency_exhausted');
    await db.exec("UPDATE shared_resource_operation_reservations SET status='completed',completed_at=now() WHERE grant_id='g2'");
    await db.exec("UPDATE shared_resource_grants SET max_operations_per_window=1 WHERE id='g2'");
    await expect(reserve('second')).rejects.toThrow('shared_grant_quota_exhausted');
    expect((await reserve('first')).created).toBe(false);
    await expect(db.exec("UPDATE shared_resource_grants SET recipient_team_id='two' WHERE id='g1'")).rejects.toThrow('shared_resource_grant_identity_immutable');
    await expect(db.exec("UPDATE shared_resource_grants SET resource_ids=ARRAY['*'] WHERE id='g1'")).rejects.toThrow();
    await expect(db.exec("UPDATE shared_resource_grants SET max_concurrent_operations=0 WHERE id='g1'")).rejects.toThrow();
    await expect(db.exec("UPDATE shared_resource_grants SET origin='default-policy' WHERE id='g1'")).rejects.toThrow();
    const allocate = (grantId: string, permissions: string[]) => db.query(`INSERT INTO vault_allocations
      (id,vault_id,team_id,path_prefix,permissions,grant_id) VALUES ('allocation','vault','one','teams/one',$1,$2)`,[permissions,grantId]);
    await expect(allocate('g1',['read'])).rejects.toThrow('vault_allocation_grant_mismatch');
    await expect(allocate('v1',['read','write'])).rejects.toThrow('vault_allocation_grant_mismatch');
    await allocate('v1',['read']);
    await db.exec(`INSERT INTO shared_resource_operation_reservations(id,grant_id,grant_version,operation_key,status)
      VALUES ('operation','g1',1,'request-1','active');`);
    const revoke = (version=1,team='owner',user='manager') => revokeOwnedSharedGrant(database,user,team,'g1',version);
    await expect(revoke(1,'owner','')).rejects.toThrow('authentication_required');
    await expect(revoke(1,'one')).rejects.toThrow('service_management_denied');
    await db.exec(`INSERT INTO team_memberships VALUES ('recipient-member','one','manager','active');
      INSERT INTO team_role_bindings VALUES ('recipient-binding','recipient-member','admin-role');`);
    await expect(revoke(1,'one')).rejects.toThrow('shared_grant_unavailable');
    await expect(revoke(2)).rejects.toThrow('version_conflict');
    await expect(revoke(0)).rejects.toThrow('invalid_version');
    await db.exec("UPDATE teams SET status='archived' WHERE id='owner'");
    await expect(revoke()).rejects.toThrow('service_management_denied');
    await db.exec("UPDATE teams SET status='active' WHERE id='owner'");
    await db.exec("UPDATE users SET status='disabled' WHERE id='manager'");
    await expect(revoke()).rejects.toThrow('service_management_denied');
    await db.exec("UPDATE users SET status='active'; UPDATE team_memberships SET status='inactive'");
    await expect(revoke()).rejects.toThrow('service_management_denied');
    await db.exec("UPDATE team_memberships SET status='active'; UPDATE roles SET key='viewer'");
    await expect(revoke()).rejects.toThrow('service_management_denied');
    await db.exec("UPDATE roles SET key='service_admin'");
    expect(await revoke()).toEqual({id:'g1',status:'revoked',version:2,changed:true});
    expect(await revoke(2)).toEqual({id:'g1',status:'revoked',version:2,changed:false});
    await expect(revoke()).rejects.toThrow('version_conflict');
    await db.exec("DELETE FROM organization_teams WHERE team_id='one'");
    expect((await db.query('SELECT id,status,version FROM shared_resource_grants ORDER BY id')).rows).toEqual([
      {id:'g1',status:'revoked',version:2},{id:'g2',status:'active',version:1},{id:'v1',status:'revoked',version:2}]);
    expect((await db.query("SELECT status FROM shared_resource_operation_reservations WHERE id='operation'")).rows).toEqual([{status:'active'}]);
    await expect(db.exec("UPDATE shared_resource_grants SET status='active' WHERE id='g1'")).rejects.toThrow('shared_resource_organization_mismatch');
    await db.exec("INSERT INTO organization_teams(team_id,organization_id) VALUES ('one','org')");
    expect((await db.query("SELECT status FROM shared_resource_grants WHERE id='g1'")).rows).toEqual([{status:'revoked'}]);
    await db.exec("UPDATE organization_teams SET organization_id='other' WHERE team_id='owner'");
    expect((await db.query("SELECT status,version FROM shared_resource_grants WHERE id='g2'")).rows).toEqual([{status:'revoked',version:2}]);
    await expect(reserve('first')).rejects.toThrow('shared_grant_inactive');
    await expect(db.exec("DELETE FROM shared_resource_grants WHERE id='g1'")).rejects.toThrow();
  } finally { await db.close(); }
},15000);
