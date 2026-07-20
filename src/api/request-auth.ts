export function bearerTokenFromRequest(request: Request): string | null {
	const header = request.headers.get('authorization');
	if (!header) return null;
	return header.match(/^Bearer\s+(.+)$/iu)?.[1] ?? null;
}
