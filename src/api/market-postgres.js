import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import pg from 'pg';

const { Pool } = pg;
const require = createRequire(import.meta.url);

const replaceConflictTargets = new Map([
	['capacity_provider_hosts', ['capacity_provider_id', 'host_id', 'role']],
	['permissions', ['key']],
	['repository_claims', ['project_id', 'repository_id', 'runner_id']],
	['role_permissions', ['role_id', 'permission_id']],
	['roles', ['key']],
	['task_estimate_profiles', ['task_signature', 'execution_profile_id']],
	['team_memberships', ['team_id', 'user_id']],
	['user_role_bindings', ['user_id', 'role_id']],
	['work_policies', ['project_id', 'environment']],
	['worker_runners', ['project_id', 'environment', 'runner_id']],
	['project_summary_snapshots', ['project_id']],
]);

function convertPlaceholders(query) {
	let index = 0;
	return query.replace(/\?/gu, () => `$${++index}`);
}

function splitSqlStatements(sql) {
	return String(sql ?? '')
		.split(/;\s*(?=(?:[^']*'[^']*')*[^']*$)/u)
		.map((statement) => statement.trim())
		.filter(Boolean);
}

function parseInsertOrReplace(query) {
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

function parseInsertOrReplaceSelect(query) {
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

function parseInsertOrIgnore(query) {
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

function translateMarketSqlToPostgres(query) {
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

function splitSqlList(sql) {
	return splitSqlStatements(sql);
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
	constructor(database, query) {
		this.database = database;
		this.query = query;
		this.bindings = [];
	}

	bind(...values) {
		this.bindings = values;
		return this;
	}

	async run() {
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

	async all() {
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

	async first() {
		const result = await this.all();
		return result.results[0] ?? null;
	}

	async raw() {
		const result = await this.all();
		return result.results.map((row) => Object.values(row));
	}
}

export class MarketPostgresDatabase {
	constructor(databaseUrl, options = {}) {
		if (typeof databaseUrl !== 'string' || !databaseUrl.trim()) {
			throw new Error('Postgres database URL is required.');
		}
		this.pool = new Pool({ connectionString: databaseUrl.trim() });
		this.migrationRoot = options.migrationRoot ?? null;
		this.migrationPromise = null;
	}

	static fromPool(pool, options = {}) {
		const database = Object.create(MarketPostgresDatabase.prototype);
		database.pool = pool;
		database.migrationRoot = options.migrationRoot ?? null;
		database.migrationPromise = null;
		return database;
	}

	prepare(query) {
		return new MarketPostgresPreparedStatement(this, query);
	}

	async exec(sql) {
		for (const statement of splitSqlStatements(sql)) {
			await this.pool.query(translateMarketSqlToPostgres(statement));
		}
		return { success: true, results: [], meta: {} };
	}

	async migrate() {
		if (!this.migrationPromise) {
			this.migrationPromise = this.applyDrizzleMigrations();
		}
		return this.migrationPromise;
	}

	async applyDrizzleMigrations() {
		const migrationRoot = this.migrationRoot ?? resolveMarketMigrationRoot();
		const files = readdirSync(migrationRoot).filter((file) => file.endsWith('.sql')).sort();
		if (files.length === 0) {
			throw new Error(`No Market Drizzle migration SQL files found in ${migrationRoot}.`);
		}
		await this.pool.query(`CREATE TABLE IF NOT EXISTS treeseed_market_schema_migrations (
			name text PRIMARY KEY,
			applied_at text NOT NULL
		)`);
		const applied = await this.pool.query(`SELECT name FROM treeseed_market_schema_migrations`);
		const appliedNames = new Set(applied.rows.map((row) => row.name));
		for (const file of files) {
			if (appliedNames.has(file)) continue;
			const sql = readFileSync(join(migrationRoot, file), 'utf8');
			await this.pool.query('BEGIN');
			try {
				for (const statement of splitSqlList(sql)) {
					const createIfNotExists = String(statement).match(/^\s*CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+["`]?([a-zA-Z0-9_]+)["`]?\s*\(/iu);
					if (createIfNotExists) {
						const tableName = createIfNotExists[1];
						const existing = await this.pool.query(
							`SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1 LIMIT 1`,
							[tableName],
						);
						if (existing.rows.length > 0) continue;
					}
					await this.pool.query(translateMarketSqlToPostgres(statement));
				}
				await this.pool.query(
					`INSERT INTO treeseed_market_schema_migrations (name, applied_at)
					 VALUES ($1, $2)
					 ON CONFLICT (name) DO NOTHING`,
					[file, new Date().toISOString()],
				);
				await this.pool.query('COMMIT');
			} catch (error) {
				await this.pool.query('ROLLBACK');
				throw new Error(`Failed to apply Market Drizzle migration ${file}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	}

	async close() {
		await this.pool.end();
	}
}

export function createMarketPostgresDatabase(databaseUrl, options = {}) {
	return new MarketPostgresDatabase(databaseUrl, options);
}
