import { ControlPlaneStore } from "../../../persistence/store.ts";
export async function firstMethod<T extends Record<string, unknown> = Record<string, unknown>>(this: ControlPlaneStore, query, params: unknown[] = []): Promise<T | null> {
    return await this.db.prepare(query).bind(...params).first() as T | null;
}
