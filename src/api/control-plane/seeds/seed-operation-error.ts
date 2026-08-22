export class SeedOperationError extends Error {
	constructor(
		readonly status: 400 | 401 | 403 | 404 | 409,
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = 'SeedOperationError';
	}
}
