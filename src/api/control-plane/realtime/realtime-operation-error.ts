export class RealtimeOperationError extends Error {
	constructor(
		readonly status: 400 | 401 | 403 | 404 | 409 | 422,
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = 'RealtimeOperationError';
	}
}
