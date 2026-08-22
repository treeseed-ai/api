import '../store/interface.ts';
import * as extractedMethods from '../store/methods.ts';
export * from '../store/support/index.ts';

export class ControlPlaneStore {
    // This is part of the public host contract consumed by the capacity facade.
    // Declare it explicitly because this legacy store is still typechecked in
    // transpile-only mode and constructor assignment alone is not emitted in its
    // inferred declaration shape.
    declare config: Record<string, unknown>;
    declare db: {
        prepare(query: string): {
            bind(...params: unknown[]): {
                run(): Promise<unknown>;
                first(): Promise<Record<string, unknown> | null>;
                all(): Promise<{ results?: Record<string, unknown>[] }>;
            };
        };
        batch?(statements: unknown[]): Promise<unknown>;
        migrate?(): Promise<unknown>;
    };
    declare initializationPromise: Promise<unknown> | null;
    declare artifactBucket: unknown;
    constructor(config, db) {
        this.config = config;
        this.db = db;
        this.initializationPromise = null;
        this.artifactBucket = null;
    }
}
extractedMethods.installControlPlaneStoreMethods(ControlPlaneStore.prototype);
