export class KnowledgeOperationError extends Error {
	constructor(
		readonly status: 400 | 401 | 403 | 404 | 409 | 412 | 422 | 429 | 500 | 503,
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = 'KnowledgeOperationError';
	}
}
