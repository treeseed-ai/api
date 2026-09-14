import {afterEach, describe, expect, it, vi} from 'vitest';
import {readdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {verifyDatabaseMigrations} from '../../../../../src/api/support/verify-database-migrations.ts';
import {ControlPlanePostgresDatabase} from '../../../../../src/api/support/control-plane-postgres.ts';

const root=resolve('drizzle/control-plane');
const files=readdirSync(root).filter(file=>file.endsWith('.sql'));
afterEach(()=>vi.unstubAllEnvs());
function pool(names=files, exists=true) {
  return {query:vi.fn(async(sql:string)=>({rows:sql.includes('to_regclass')?[{ledger:exists?'ledger':null}]
		:sql.includes('information_schema.columns')?[]:names.map(name=>({name}))}))};
}
describe('database migration boundary',()=>{
  it('only reads an already applied inventory',async()=>{
    const db=pool();await verifyDatabaseMigrations(db,root);
    expect(db.query.mock.calls.every(([sql])=>sql.startsWith('SELECT'))).toBe(true);
  });
  it('rejects an uninitialized database without creating a ledger',async()=>{
    const db=pool([],false);
    await expect(verifyDatabaseMigrations(db,root)).rejects.toThrow('database_requires_explicit_migration');
    expect(db.query).toHaveBeenCalledTimes(1);
  });
	it('rejects pending and newer database generations without writes',async()=>{
		for(const [names, message] of [[files.slice(1),'database_migration_inventory_mismatch_pending_1_unexpected_0'],
			[[...files,'9999_future.sql'],'database_migration_inventory_mismatch_pending_0_unexpected_1']] as const) {
			const db=pool(names);
			await expect(verifyDatabaseMigrations(db,root)).rejects.toThrow(message);
      expect(db.query.mock.calls.every(([sql])=>sql.startsWith('SELECT'))).toBe(true);
    }
  });
	it('defaults every application connection to read-only schema verification',async()=>{
    const connection={...pool(),on:vi.fn()};
    const db=ControlPlanePostgresDatabase.fromPool(connection as never,{migrationRoot:root});
    await db.migrate();await db.migrate();
    expect(connection.query).toHaveBeenCalledTimes(2);
		expect(connection.query.mock.calls.every(([sql])=>sql.startsWith('SELECT'))).toBe(true);
	});
	it('reports the exact safe source and ledger inventory',async()=>{
		const connection={...pool([...files,'9999_future.sql']),on:vi.fn()};
		const db=ControlPlanePostgresDatabase.fromPool(connection as never,{migrationRoot:root});
		expect(await db.migrationInventory()).toEqual({source:[...files].sort(),applied:[...files,'9999_future.sql'],pending:[],unexpected:['9999_future.sql'],
			schema:{execution_edges:[],execution_graph_revisions:[],execution_nodes:[]}});
	});
  it('rejects explicit apply inside a live service even outside the CLI',async()=>{
    vi.stubEnv('TREESEED_DEVELOPMENT_MODE','live');
    const connection={...pool(),on:vi.fn()};
    const db=ControlPlanePostgresDatabase.fromPool(connection as never,{migrationRoot:root,migrationMode:'apply'});
    await expect(db.migrate()).rejects.toThrow('live_migration_apply_forbidden');
    expect(connection.query).not.toHaveBeenCalled();
  });
});
