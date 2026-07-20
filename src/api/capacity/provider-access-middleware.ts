import type { Context, MiddlewareHandler } from 'hono';

interface CapacityProviderAccessAuthenticator {
	authenticateAccessToken(accessToken: string): Promise<unknown>;
}

export function capacityProviderBearerToken(c: Context) {
	const value = c.req.header('authorization')?.trim() ?? '';
	return value.startsWith('Bearer tspa_') ? value.slice('Bearer '.length).trim() : '';
}

export function createCapacityProviderAccessMiddleware(
	authenticator: CapacityProviderAccessAuthenticator,
): MiddlewareHandler {
	return async (c, next) => {
		const token = capacityProviderBearerToken(c);
		if (token) c.set('capacityProviderAccessAuth', await authenticator.authenticateAccessToken(token));
		await next();
	};
}
