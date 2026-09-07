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

/** Stable diagnostics only: upstream payloads may contain credentials or private paths. */
export function knowledgeReadFailure(code: string, message: string, cause: unknown) {
	const upstream = cause && typeof cause === 'object' ? (cause as { code?: unknown }).code : undefined;
	const allowed = ['graph_not_ready', 'permission_denied', 'authentication_required', 'not_found',
		'network_error', 'request_cancelled', 'validation_error'];
	const diagnostic = typeof upstream === 'string' && allowed.includes(upstream) ? upstream : 'unexpected_response';
	return new KnowledgeOperationError(503, code, `${message} (TreeDX: ${diagnostic})`);
}
