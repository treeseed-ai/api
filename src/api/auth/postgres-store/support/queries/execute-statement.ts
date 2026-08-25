import { PostgresAuthStore } from "../../../postgres-store.ts";
export async function runMethod(this: PostgresAuthStore, query: string, params: unknown[] = []) {
    await this.db.prepare(query).bind(...params).run();
}

