export class SeedOperationError extends Error {
	constructor(
		readonly status: 400 | 401 | 403 | 404 | 409 | 500 | 502 | 503,
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = 'SeedOperationError';
	}
}
