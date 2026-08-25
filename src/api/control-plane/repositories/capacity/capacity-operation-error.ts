export class CapacityOperationError extends Error {
	constructor(readonly status: number, readonly code: string, message: string) {
		super(message);
		this.name = 'CapacityOperationError';
	}
}
