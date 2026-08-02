import { MarketControlPlaneStore } from "../../../persistence/store.ts";
export async function runMethod(this: MarketControlPlaneStore, query, params: unknown[] = []) {
    return await this.db.prepare(query).bind(...params).run();
}
