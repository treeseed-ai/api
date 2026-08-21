import { PostgresAuthStore } from "../../../postgres-store.ts";
export async function firstMethod<T = Record<string, unknown>>(this: PostgresAuthStore, query: string, params: unknown[] = []) {
    return this.db.prepare(query).bind(...params).first<T>();
}

