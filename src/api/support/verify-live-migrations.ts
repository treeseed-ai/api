import { readdirSync } from 'node:fs';

/** Live startup must never create/adopt tables or apply pending migrations. */
export async function verifyLiveMigrations(pool: {query: (sql: string) => Promise<{rows: any[]}>}, migrationRoot: string) {
  const files = readdirSync(migrationRoot).filter(file => file.endsWith('.sql')).sort();
  if (!files.length) throw new Error('live_migration_inventory_missing');
  const exists = await pool.query("SELECT to_regclass('public.treeseed_control_plane_schema_migrations') AS ledger");
  if (!exists.rows[0]?.ledger) throw new Error('live_database_requires_explicit_migration');
  const applied = await pool.query('SELECT name FROM treeseed_control_plane_schema_migrations');
  const names = new Set(applied.rows.map(row => row.name));
  const pending = files.filter(file => !names.has(file));
  const unexpected = [...names].filter(name => !files.includes(name));
  if (pending.length || unexpected.length) throw new Error('live_database_migration_inventory_mismatch');
}
