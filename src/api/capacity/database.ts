export interface CapacityDatabaseOperation {
	query: string;
	params?: unknown[];
}

export interface CapacityGovernanceDatabase {
	ensureInitialized(): Promise<unknown>;
	run(query: string, params?: unknown[]): Promise<void>;
	first<T extends Record<string, unknown> = Record<string, unknown>>(query: string, params?: unknown[]): Promise<T | null>;
	all<T extends Record<string, unknown> = Record<string, unknown>>(query: string, params?: unknown[]): Promise<T[]>;
	batch(operations: CapacityDatabaseOperation[]): Promise<unknown>;
}

export class CapacityGovernanceError extends Error {
	readonly code: string;
	readonly status: number;
	readonly details?: Record<string, unknown>;

	constructor(code: string, message: string, status = 400, details?: Record<string, unknown>) {
		super(message);
		this.name = 'CapacityGovernanceError';
		this.code = code;
		this.status = status;
		this.details = details;
	}
}
