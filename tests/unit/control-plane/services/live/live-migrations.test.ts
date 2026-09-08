import {describe, expect, it, vi} from 'vitest';
import {readdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {verifyLiveMigrations} from '../../../../../src/api/support/verify-live-migrations.ts';

const root=resolve('drizzle/control-plane');
const files=readdirSync(root).filter(file=>file.endsWith('.sql'));
function pool(names=files, exists=true) {
  return {query:vi.fn(async(sql:string)=>({rows:sql.includes('to_regclass')?[{ledger:exists?'ledger':null}]:names.map(name=>({name}))}))};
}
describe('live database migration boundary',()=>{
  it('only reads an already applied inventory',async()=>{
    const db=pool();await verifyLiveMigrations(db,root);
    expect(db.query.mock.calls.every(([sql])=>sql.startsWith('SELECT'))).toBe(true);
  });
  it('rejects an uninitialized database without creating a ledger',async()=>{
    const db=pool([],false);
    await expect(verifyLiveMigrations(db,root)).rejects.toThrow('live_database_requires_explicit_migration');
    expect(db.query).toHaveBeenCalledTimes(1);
  });
  it('rejects pending and newer database generations without writes',async()=>{
    for(const names of [files.slice(1),[...files,'9999_future.sql']]) {
      const db=pool(names);
      await expect(verifyLiveMigrations(db,root)).rejects.toThrow('live_database_migration_inventory_mismatch');
      expect(db.query.mock.calls.every(([sql])=>sql.startsWith('SELECT'))).toBe(true);
    }
  });
});
