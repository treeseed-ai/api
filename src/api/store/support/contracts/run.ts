import { ControlPlaneStore } from "../../../persistence/store.ts";
export async function runMethod(this: ControlPlaneStore, query, params: unknown[] = []) {
    return await this.db.prepare(query).bind(...params).run();
}
