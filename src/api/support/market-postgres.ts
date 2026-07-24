import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import pg, { type Pool, type PoolClient, type QueryResultRow } from 'pg';
import { splitPostgresSqlStatements } from '../persistence/postgres-sql-statements.ts';

const { Pool: PgPool } = pg;
const require = createRequire(import.meta.url);
const loggedPostgresPools = new WeakSet<Pool>();

function attachPostgresPoolErrorLogger(pool: Pool) {
	if (loggedPostgresPools.has(pool)) return;
	loggedPostgresPools.add(pool);
	pool.on('error', (error) => {
		const code = 'code' in error ? error.code : null;
		const message = error instanceof Error ? error.message : String(error);
		console.warn('[api] PostgreSQL pool idle client error', { code, message });
	});
}

type PostgresQueryable = Pick<Pool | PoolClient, 'query'>;
type PreparedResult = { success: true; results: QueryResultRow[]; meta: Record<string, never> };

const replaceConflictTargets = new Map([
	['permissions', ['key']],
	['role_permissions', ['role_id', 'permission_id']],
	['roles', ['key']],
	['team_memberships', ['team_id', 'user_id']],
	['user_role_bindings', ['user_id', 'role_id']],
	['project_summary_snapshots', ['project_id']],
]);

function convertPlaceholders(query: string): string {
	let index = 0;
	return query.replace(/\?/gu, () => `$${++index}`);
}

function splitSqlStatements(sql: string): string[] {
	return splitPostgresSqlStatements(String(sql ?? ''));
}

function parseInsertOrReplace(query: string) {
	const match = String(query).match(/^\s*INSERT\s+OR\s+REPLACE\s+INTO\s+([a-zA-Z0-9_]+)\s*\(([\s\S]+?)\)\s+VALUES\s*\(([\s\S]+)\)\s*$/iu);
	if (!match) return null;
	const table = match[1];
	const columns = match[2]
		.split(',')
		.map((column) => column.trim())
		.filter(Boolean);
	const values = match[3];
	const conflictColumns = replaceConflictTargets.get(table) ?? (columns.includes('id') ? ['id'] : [columns[0]]);
	const updateColumns = columns.filter((column) => !conflictColumns.includes(column));
	return {
		table,
		columns,
		values,
		conflictColumns,
		updateColumns,
	};
}

function parseInsertOrReplaceSelect(query: string) {
	const match = String(query).match(/^\s*INSERT\s+OR\s+REPLACE\s+INTO\s+([a-zA-Z0-9_]+)\s*\(([\s\S]+?)\)\s+(SELECT[\s\S]+)$/iu);
	if (!match) return null;
	const table = match[1];
	const columns = match[2]
		.split(',')
		.map((column) => column.trim())
		.filter(Boolean);
	const selectSql = match[3];
	const conflictColumns = replaceConflictTargets.get(table) ?? (columns.includes('id') ? ['id'] : [columns[0]]);
	const updateColumns = columns.filter((column) => !conflictColumns.includes(column));
	return {
		table,
		columns,
		selectSql,
		conflictColumns,
		updateColumns,
	};
}

function parseInsertOrIgnore(query: string) {
	const match = String(query).match(/^\s*INSERT\s+OR\s+IGNORE\s+INTO\s+([a-zA-Z0-9_]+)\s*\(([\s\S]+?)\)\s+VALUES\s*\(([\s\S]+)\)\s*$/iu);
	if (!match) return null;
	const table = match[1];
	const columns = match[2]
		.split(',')
		.map((column) => column.trim())
		.filter(Boolean);
	const values = match[3];
	const conflictColumns = replaceConflictTargets.get(table) ?? (columns.includes('id') ? ['id'] : [columns[0]]);
	return {
		table,
		columns,
		values,
		conflictColumns,
	};
}

function translateMarketSqlToPostgres(query: string): string {
	const normalizedQuery = String(query ?? '');
	if (/^\s*INSERT\s+OR\s+IGNORE\s+INTO\s+team_role_bindings\s*\(\s*team_membership_id\s*,\s*role_id\s*,\s*created_at\s*\)\s+VALUES\s*\(\s*\?\s*,\s*\?\s*,\s*\?\s*\)\s*$/iu.test(normalizedQuery)) {
		return `INSERT INTO team_role_bindings (id, team_membership_id, role_id, created_at)
			VALUES (md5($1 || ':' || $2), $1, $2, $3)
			ON CONFLICT (id) DO NOTHING`;
	}
	const insertOrReplace = parseInsertOrReplace(query);
	if (insertOrReplace) {
		const assignments = insertOrReplace.updateColumns
			.map((column) => `${column} = EXCLUDED.${column}`)
			.join(', ');
		const conflict = insertOrReplace.conflictColumns.join(', ');
		const update = assignments ? `DO UPDATE SET ${assignments}` : 'DO NOTHING';
		return convertPlaceholders(
			`INSERT INTO ${insertOrReplace.table} (${insertOrReplace.columns.join(', ')}) VALUES (${insertOrReplace.values}) ON CONFLICT (${conflict}) ${update}`,
		);
	}
	const insertOrReplaceSelect = parseInsertOrReplaceSelect(query);
	if (insertOrReplaceSelect) {
		const assignments = insertOrReplaceSelect.updateColumns
			.map((column) => `${column} = EXCLUDED.${column}`)
			.join(', ');
		const conflict = insertOrReplaceSelect.conflictColumns.join(', ');
		const update = assignments ? `DO UPDATE SET ${assignments}` : 'DO NOTHING';
		return convertPlaceholders(
			`INSERT INTO ${insertOrReplaceSelect.table} (${insertOrReplaceSelect.columns.join(', ')}) ${insertOrReplaceSelect.selectSql} ON CONFLICT (${conflict}) ${update}`,
		);
	}
	const insertOrIgnore = parseInsertOrIgnore(query);
	if (insertOrIgnore) {
		return convertPlaceholders(
			`INSERT INTO ${insertOrIgnore.table} (${insertOrIgnore.columns.join(', ')}) VALUES (${insertOrIgnore.values}) ON CONFLICT (${insertOrIgnore.conflictColumns.join(', ')}) DO NOTHING`,
		);
	}
	return convertPlaceholders(query)
		.replace(/json_extract\(\s*input_json\s*,\s*'\$\.capacity\.providerId'\s*\)/giu, "(input_json::jsonb -> 'capacity' ->> 'providerId')")
		.replace(/\bINTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT\b/giu, 'INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY');
}

function splitSqlList(sql: string): string[] {
	return splitSqlStatements(sql);
}

async function tableExists(pool: PostgresQueryable, tableName: string): Promise<boolean> {
	const existing = await pool.query(
		`SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1 LIMIT 1`,
		[tableName],
	);
	return existing.rows.length > 0;
}

async function constraintExists(pool: PostgresQueryable, tableName: string, constraintName: string): Promise<boolean> {
	const postgresName = constraintName.slice(0, 63);
	const existing = await pool.query(
		`SELECT 1
		 FROM information_schema.table_constraints
		 WHERE table_schema = 'public'
		   AND table_name = $1
		   AND (constraint_name = $2 OR constraint_name = $3)
		 LIMIT 1`,
		[tableName, constraintName, postgresName],
	);
	return existing.rows.length > 0;
}

async function hasAdoptableBaselineSchema(pool: PostgresQueryable): Promise<boolean> {
	const baselineTables = [
		'agent_capacity_plans',
		'better_auth_user',
		'capacity_ledger_entries',
		'capacity_providers',
		'capacity_reservations',
		'capacity_workday_demands',
		'capacity_workday_participation_cycles',
		'capacity_workday_participation_entries',
		'market_operation_runners',
		'platform_operations',
		'capacity_provider_assignments',
		'projects',
		'capacity_usage_actuals',
		'teams',
		'treedx_project_proxy_audit',
		'web_sessions',
	];
	for (const tableName of baselineTables) {
		if (!(await tableExists(pool, tableName))) return false;
	}
	return true;
}

function resolveMarketMigrationRoot() {
	const candidates = [
		resolve(process.cwd(), 'packages/sdk/drizzle/market'),
		resolve(process.cwd(), 'node_modules/@treeseed/sdk/drizzle/market'),
	];
	try {
		candidates.push(resolve(dirname(dirname(require.resolve('@treeseed/sdk'))), 'drizzle/market'));
	} catch {
		// Optional in isolated test contexts.
	}
	const found = candidates.find((candidate) => {
		try {
			return readdirSync(candidate).some((file) => file.endsWith('.sql'));
		} catch {
			return false;
		}
	});
	if (!found) {
		throw new Error('Unable to locate Market Drizzle migrations. Run npm run db:generate:market and ensure @treeseed/sdk includes drizzle/market artifacts.');
	}
	return found;
}

class MarketPostgresPreparedStatement {
	private bindings: unknown[] = [];

	constructor(
		private readonly database: MarketPostgresDatabase,
		private readonly query: string,
	) {}

	bind(...values: unknown[]): this {
		this.bindings = values;
		return this;
	}

	async run(): Promise<PreparedResult> {
		await this.database.migrate();
		const createIfNotExists = String(this.query).match(/^\s*CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+["`]?([a-zA-Z0-9_]+)["`]?\s*\(/iu);
		if (createIfNotExists) {
			const tableName = createIfNotExists[1];
			const existing = await this.database.pool.query(
				`SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1 LIMIT 1`,
				[tableName],
			);
			if (existing.rows.length > 0) return { success: true, results: [], meta: {} };
		}
		await this.database.pool.query(translateMarketSqlToPostgres(this.query), this.bindings);
		return { success: true, results: [], meta: {} };
	}

	async all(): Promise<PreparedResult> {
		await this.database.migrate();
		if (/^\s*PRAGMA\s+table_info\(([^)]+)\)/iu.test(this.query)) {
			const tableName = this.query.match(/^\s*PRAGMA\s+table_info\(([^)]+)\)/iu)?.[1]?.replace(/['"`]/gu, '') ?? '';
			const result = await this.database.pool.query(
				`SELECT column_name AS name, data_type AS type
				 FROM information_schema.columns
				 WHERE table_schema = 'public' AND table_name = $1
				 ORDER BY ordinal_position ASC`,
				[tableName],
			);
			return { success: true, results: result.rows, meta: {} };
		}
		const result = await this.database.pool.query(translateMarketSqlToPostgres(this.query), this.bindings);
		return { success: true, results: result.rows, meta: {} };
	}

	async first(): Promise<QueryResultRow | null> {
		const result = await this.all();
		return result.results[0] ?? null;
	}

	async raw(): Promise<unknown[][]> {
		const result = await this.all();
		return result.results.map((row) => Object.values(row));
	}
}

export class MarketPostgresDatabase {
	pool: Pool;
	private migrationRoot: string | null;
	private migrationPromise: Promise<void> | null;

	constructor(databaseUrl: string, options: { migrationRoot?: string | null } = {}) {
		if (typeof databaseUrl !== 'string' || !databaseUrl.trim()) {
			throw new Error('Postgres database URL is required.');
		}
		this.pool = new PgPool({ connectionString: databaseUrl.trim() });
		attachPostgresPoolErrorLogger(this.pool);
		this.migrationRoot = options.migrationRoot ?? null;
		this.migrationPromise = null;
	}

	static fromPool(pool: Pool, options: { migrationRoot?: string | null } = {}): MarketPostgresDatabase {
		const database = Object.create(MarketPostgresDatabase.prototype) as MarketPostgresDatabase;
		database.pool = pool;
		attachPostgresPoolErrorLogger(database.pool);
		database.migrationRoot = options.migrationRoot ?? null;
		database.migrationPromise = null;
		return database;
	}

	prepare(query: string): MarketPostgresPreparedStatement {
		return new MarketPostgresPreparedStatement(this, query);
	}

	async batch(statements: Array<{ query: string; bindings?: unknown[]; params?: unknown[] }>): Promise<PreparedResult[]> {
		await this.migrate();
		const client = await this.pool.connect();
		try {
			await client.query('BEGIN');
			const results = [];
			for (const statement of statements) {
				const result = await client.query(translateMarketSqlToPostgres(statement.query), statement.bindings ?? statement.params ?? []);
				results.push({ success: true, results: result.rows ?? [], meta: {} });
			}
			await client.query('COMMIT');
			return results;
		} catch (error) {
			await client.query('ROLLBACK');
			throw error;
		} finally {
			client.release();
		}
	}

	async exec(sql: string): Promise<PreparedResult> {
		for (const statement of splitSqlStatements(sql)) {
			await this.pool.query(translateMarketSqlToPostgres(statement));
		}
		return { success: true, results: [], meta: {} };
	}

	async migrate(): Promise<void> {
		if (!this.migrationPromise) {
			this.migrationPromise = this.applyDrizzleMigrations();
		}
		return this.migrationPromise;
	}

	private async applyDrizzleMigrations(): Promise<void> {
		const migrationRoot = this.migrationRoot ?? resolveMarketMigrationRoot();
		const files = readdirSync(migrationRoot).filter((file) => file.endsWith('.sql')).sort();
		if (files.length === 0) {
			throw new Error(`No Market Drizzle migration SQL files found in ${migrationRoot}.`);
		}
		if (!(await tableExists(this.pool, 'treeseed_market_schema_migrations'))) {
			await this.pool.query(`CREATE TABLE IF NOT EXISTS treeseed_market_schema_migrations (
				name text PRIMARY KEY,
				applied_at text NOT NULL
			)`);
		}
		const applied = await this.pool.query(`SELECT name FROM treeseed_market_schema_migrations`);
		const appliedNames = new Set(applied.rows.map((row) => row.name));
		if (appliedNames.has('0000_market_control_plane.sql') && !(await hasAdoptableBaselineSchema(this.pool))) {
			appliedNames.delete('0000_market_control_plane.sql');
		}
		for (const file of files) {
			if (appliedNames.has(file)) continue;
			if (file === '0000_market_control_plane.sql' && await hasAdoptableBaselineSchema(this.pool)) {
				await this.pool.query(
					`INSERT INTO treeseed_market_schema_migrations (name, applied_at)
					 VALUES ($1, $2)
					 ON CONFLICT (name) DO NOTHING`,
					[file, new Date().toISOString()],
				);
				appliedNames.add(file);
				continue;
			}
			const sql = readFileSync(join(migrationRoot, file), 'utf8');
			const client = await this.pool.connect();
			try {
				await client.query('BEGIN');
				for (const statement of splitSqlList(sql)) {
					const createTable = String(statement).match(/^\s*CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?([a-zA-Z0-9_]+)["`]?\s*\(/iu);
					if (createTable) {
						const tableName = createTable[1];
						if (await tableExists(client, tableName)) continue;
					}
					const addConstraint = String(statement).match(
						/^\s*ALTER\s+TABLE\s+["`]?([a-zA-Z0-9_]+)["`]?\s+ADD\s+CONSTRAINT\s+["`]?([a-zA-Z0-9_]+)["`]?/iu,
					);
					if (addConstraint && await constraintExists(client, addConstraint[1], addConstraint[2])) continue;
					const createIndex = String(statement).match(/^\s*CREATE\s+(UNIQUE\s+)?INDEX\s+(?!IF\s+NOT\s+EXISTS\b)/iu);
					const statementToApply = createIndex
						? String(statement).replace(/^\s*CREATE\s+(UNIQUE\s+)?INDEX\s+/iu, (_match, unique = '') => `CREATE ${unique}INDEX IF NOT EXISTS `)
						: statement;
					await client.query(translateMarketSqlToPostgres(statementToApply));
				}
				await client.query(
					`INSERT INTO treeseed_market_schema_migrations (name, applied_at)
					 VALUES ($1, $2)
					 ON CONFLICT (name) DO NOTHING`,
					[file, new Date().toISOString()],
				);
				await client.query('COMMIT');
			} catch (error) {
				await client.query('ROLLBACK');
				throw new Error(`Failed to apply Market Drizzle migration ${file}: ${error instanceof Error ? error.message : String(error)}`);
			} finally {
				client.release();
			}
		}
	}

	async close(): Promise<void> {
		await this.pool.end();
	}
}

export function createMarketPostgresDatabase(databaseUrl: string, options: { migrationRoot?: string | null } = {}): MarketPostgresDatabase {
	return new MarketPostgresDatabase(databaseUrl, options);
}
