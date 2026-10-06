import {expect, it, vi} from 'vitest';
import {ControlPlanePostgresDatabase} from '../../../../src/api/support/control-plane-postgres';

function database() {
  const client = {query: vi.fn(async (_sql: string) => ({rows: [], rowCount: 1})), release: vi.fn()};
  const pool = {on: vi.fn(), connect: vi.fn(async () => client)};
  const db = ControlPlanePostgresDatabase.fromPool(pool as any);
  vi.spyOn(db,'migrate').mockResolvedValue();
  return {db, client, pool};
}
it('keeps resource authorization and mutation on one transaction connection', async () => {
  const {db,client,pool} = database();
  expect(await db.transaction(async tx => {
    expect(tx).toBe(client);
    await tx.query('SELECT resource FOR UPDATE');
    await tx.query('INSERT resource');
    return 'receipt';
  })).toBe('receipt');
  expect(pool.connect).toHaveBeenCalledTimes(1);
  expect(client.query.mock.calls.map(args => args[0])).toEqual(['BEGIN','SELECT resource FOR UPDATE','INSERT resource','COMMIT']);
  expect(client.release).toHaveBeenCalledTimes(1);
});
it('rolls back rejected resource work and always releases the client', async () => {
  const {db,client} = database();
  await expect(db.transaction(async () => { throw new Error('access_denied'); })).rejects.toThrow('access_denied');
  expect(client.query.mock.calls.map(args => args[0])).toEqual(['BEGIN','ROLLBACK']);
  expect(client.release).toHaveBeenCalledTimes(1);
});
it('never opens a transaction if the live migration guard rejects the database', async () => {
  const {db,pool} = database();
  vi.mocked(db.migrate).mockRejectedValue(new Error('live_database_migration_inventory_mismatch'));
  await expect(db.transaction(async () => {})).rejects.toThrow('live_database_migration_inventory_mismatch');
  expect(pool.connect).not.toHaveBeenCalled();
});
