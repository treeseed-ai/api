import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {expect, it} from 'vitest';
import {splitPostgresSqlStatements} from '../../../../src/api/persistence/postgres-sql-statements';

it('keeps vault allocations isolated and pins each connection to its owning team allocation', async () => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE TABLE teams(id text PRIMARY KEY); INSERT INTO teams VALUES ('owner'),('recipient');
      CREATE TABLE team_service_connections(id text PRIMARY KEY,team_id text NOT NULL REFERENCES teams(id),version int);
      INSERT INTO team_service_connections VALUES ('connection','owner',7);`);
    // Exercise the production migration splitter, including PL/pgSQL bodies.
    for (const statement of splitPostgresSqlStatements(readFileSync('drizzle/control-plane/0014_vault_registry.sql','utf8')))
      await db.exec(statement);
    expect((await db.query('SELECT * FROM team_service_connections')).rows).toEqual([{id:'connection',team_id:'owner',version:7}]);
    expect((await db.query('SELECT * FROM service_connection_vault_bindings')).rows).toEqual([]);
    await db.exec(`INSERT INTO vault_registrations
      (id,owner_team_id,display_name,backend,endpoint,secrets_mount,network_route_id,tls_trust_id,auth_mount,role_id,bootstrap_credential_ref)
      VALUES ('vault','owner','Vault','managed-openbao','https://vault.example.test','treeseed','route','trust','approle','role','bootstrap');
      INSERT INTO vault_allocations(id,vault_id,team_id,path_prefix,permissions)
      VALUES ('a','vault','owner','teams/owner',ARRAY['read','write']),('b','vault','recipient','teams/recipient',ARRAY['read']);`);
    for (const path of ['teams/owner','teams/owner/child','teams']) {
      await expect(db.query(`INSERT INTO vault_allocations(id,vault_id,team_id,path_prefix,permissions)
        VALUES ('collision','vault','recipient',$1,ARRAY['read'])`,[path])).rejects.toThrow();
    }
    await expect(db.exec("UPDATE vault_allocations SET path_prefix='elsewhere' WHERE id='a'")).rejects.toThrow('vault_allocation_relocation_requires_migration');
    for (const path of ['../owner', 'teams//owner', '/teams/owner', 'teams/%', 'teams/owner/..'])
      await expect(db.query("INSERT INTO vault_allocations(id,vault_id,team_id,path_prefix,permissions) VALUES ('invalid','vault','owner',$1,ARRAY['read'])",[path])).rejects.toThrow();
    await db.exec("INSERT INTO vault_allocations(id,vault_id,team_id,path_prefix,permissions) VALUES ('adjacent','vault','recipient','teams/owner-other',ARRAY['read'])");
    await expect(db.exec("UPDATE vault_allocations SET permissions=ARRAY['root'] WHERE id='a'")).rejects.toThrow();
    await expect(db.exec("UPDATE vault_allocations SET permissions=ARRAY[]::text[] WHERE id='a'")).rejects.toThrow();
    await expect(db.exec("INSERT INTO service_connection_vault_bindings VALUES ('connection','recipient','vault','b',1)")).rejects.toThrow('connection_vault_team_mismatch');
    await expect(db.exec("INSERT INTO service_connection_vault_bindings VALUES ('connection','owner','vault','b',1)")).rejects.toThrow();
    await db.exec("INSERT INTO service_connection_vault_bindings VALUES ('connection','owner','vault','a',1)");
    await db.exec(`INSERT INTO vault_credential_references(connection_id,profile_id,vault_id,allocation_id,mode,record_path)
      VALUES ('connection','managed-profile','vault','a','managed','records/managed');
      INSERT INTO vault_credential_references(connection_id,profile_id,vault_id,allocation_id,mode,record_path,field_mapping,pinned_version)
      VALUES ('connection','reference-profile','vault','a','existing','records/external','{"apiToken":"token"}',3);`);
    await expect(db.exec("UPDATE vault_credential_references SET allocation_id='b'")).rejects.toThrow();
    await expect(db.exec("UPDATE vault_credential_references SET field_mapping='{}' WHERE mode='existing'")).rejects.toThrow();
    await expect(db.exec("UPDATE vault_credential_references SET pinned_version=0 WHERE mode='existing'")).rejects.toThrow();
    await expect(db.exec("UPDATE vault_credential_references SET pinned_version=1 WHERE mode='managed'")).rejects.toThrow();
    await expect(db.exec("DELETE FROM service_connection_vault_bindings WHERE connection_id='connection'")).rejects.toThrow();
    await expect(db.exec("DELETE FROM vault_allocations WHERE id='a'")).rejects.toThrow();
    await expect(db.exec("DELETE FROM vault_registrations WHERE id='vault'")).rejects.toThrow();
    expect((await db.query('SELECT version FROM team_service_connections')).rows).toEqual([{version:7}]);
    expect((await db.query('SELECT version FROM vault_registrations')).rows).toEqual([{version:1}]);
  } finally { await db.close(); }
}, 15000);
