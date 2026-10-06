import { PostgresAuthStore } from "../../../postgres-store.ts";
export async function allMethod<T extends Record<string, unknown> = Record<string, unknown>>(this: PostgresAuthStore, query: string, params: unknown[] = []) {
    const result = await this.db.prepare(query).bind(...params).all<T>();
    return result.results ?? [];
}
