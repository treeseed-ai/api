import { ControlPlaneStore } from "../../../persistence/store.ts";
export async function batchMethod(this: ControlPlaneStore, operations) {
    if (typeof this.db.batch !== 'function')
        throw new Error('The configured database does not support transactional batches.');
    const statements = operations.map(({ query, params = [] }) => this.db.prepare(query).bind(...params));
    return this.db.batch(statements);
}
