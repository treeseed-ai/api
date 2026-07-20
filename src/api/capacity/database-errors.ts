interface DatabaseErrorShape {
	code?: unknown;
	constraint?: unknown;
	message?: unknown;
}

export function isUniqueConstraintViolation(error: unknown, constraint?: string): boolean {
	if (!error || typeof error !== 'object') return false;
	const candidate = error as DatabaseErrorShape;
	const code = String(candidate.code ?? '');
	const message = String(candidate.message ?? '');
	const unique = code === '23505'
		|| code === 'SQLITE_CONSTRAINT'
		|| code === 'SQLITE_CONSTRAINT_UNIQUE'
		|| /duplicate key|unique constraint|already exists/iu.test(message);
	if (!unique || !constraint) return unique;
	return String(candidate.constraint ?? '').includes(constraint) || message.includes(constraint);
}
