import type { Context } from 'hono';
import type { ApiPrincipal, ApiScope } from '@treeseed/sdk';
import type { AppVariables } from './types.ts';

export type ApiContext = Context<{ Variables: AppVariables }>;

export function jsonError(
	c: Context,
	status: number,
	error: string,
	details?: Record<string, unknown>,
) {
	return c.json({
		ok: false,
		error,
		...(details ?? {}),
	}, status);
}

export function bearerTokenFromRequest(request: Request) {
	const header = request.headers.get('authorization');
	if (!header) return null;
	const match = header.match(/^Bearer\s+(.+)$/i);
	return match?.[1] ?? null;
}

export function hasScope(principal: ApiPrincipal | null, requiredScope: ApiScope) {
	return Boolean(principal && (principal.scopes.includes(requiredScope) || principal.scopes.includes('*')));
}

export function requireScope(c: ApiContext, requiredScope: ApiScope) {
	if (!hasScope(c.get('principal'), requiredScope)) {
		return jsonError(c, 401, 'Authentication required.', { requiredScope });
	}
	return null;
}
