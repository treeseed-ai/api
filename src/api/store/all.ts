import { ControlPlaneStore } from "../persistence/store.ts";
export async function allMethod<T extends Record<string, unknown> = Record<string, unknown>>(this: ControlPlaneStore, query: string, params: unknown[] = []): Promise<T[]> {
    const result = await this.db.prepare(query).bind(...params).all();
    return (result.results ?? []) as T[];
}
