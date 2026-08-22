import { AUTH_SCHEMA_SQL,PostgresAuthStore } from "../../../postgres-store.ts";
export async function ensureAuthSchemaMethod(this: PostgresAuthStore) {
    for (const statement of AUTH_SCHEMA_SQL)
        await this.run(statement);
    const result = await this.db.prepare('PRAGMA table_info(users)').all<{
        name: string;
    }>();
    const columns = new Set((result.results ?? []).map((row) => row.name));
    if (!columns.has('username')) {
        await this.run('ALTER TABLE users ADD COLUMN username TEXT');
    }
    await this.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username)');
}

