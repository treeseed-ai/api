import { createMcpHonoApp } from '@modelcontextprotocol/hono';
import { OAuthError, OAuthErrorCode, requireBearerAuth, type ServerEventBus } from '@modelcontextprotocol/server';
import type { Hono } from 'hono';
import { controlPlaneOperations } from '../catalog/index.ts';
import type { OperationRegistry } from '../catalog/operation-registry.ts';
import { createControlPlaneMcpHandler } from '../mcp/create-mcp-handler.ts';
import { createMcpCatalog, mcpCatalogDigest } from '../mcp/mcp-catalog.ts';
import { generateOpenApi, openApiDigest } from '../openapi/generate-openapi.ts';
import { createOperationHttpHandler } from './operation-http-handler.ts';
import type { ConfirmationService } from '../confirmation/confirmation-service.ts';

export interface AuthenticatedPrincipal {
	principal: { id: string; displayName?: string; scopes?: string[]; roles?: string[]; permissions?: string[]; metadata?: Record<string, unknown> };
	credential: { id: string; oauthClientId?: string; expiresAt?: number };
}

/** Resource operations only. Authentication issuers and browser bridges are
 * composed by the application, never inferred from a request Host header. */
export function installControlPlaneResourceRoutes(
	app: Hono,
	authenticateBearerToken: (token: string) => Promise<AuthenticatedPrincipal | null>,
	registry: OperationRegistry = controlPlaneOperations,
	confirmations?: ConfirmationService,
	mcpBusForPrincipal?: (principal: AuthenticatedPrincipal['principal']) => Promise<ServerEventBus | undefined>,
	publicBaseUrl = process.env.TREESEED_API_BASE_URL ?? 'http://127.0.0.1:3002',
) {
	const document = generateOpenApi(registry, publicBaseUrl.replace(/\/+$/u, ''));
	const digest = openApiDigest(document);
	const mcpCatalog = createMcpCatalog(registry);
	const mcpDigest = mcpCatalogDigest(mcpCatalog);
	const mcpHandler = createControlPlaneMcpHandler(registry, confirmations);
	const bearerGate = requireBearerAuth({
		verifier: {
			async verifyAccessToken(token) {
				let authenticated: AuthenticatedPrincipal | null;
				try { authenticated = await authenticateBearerToken(token); }
				catch { throw new OAuthError(OAuthErrorCode.InvalidToken, 'The access token is invalid, expired, or revoked.'); }
				if (!authenticated) throw new OAuthError(OAuthErrorCode.InvalidToken, 'The access token is invalid, expired, or revoked.');
				const scopes = authenticated.principal.scopes?.filter((scope) => scope.startsWith('treeseed:')) ?? [];
				return {
					token,
					clientId: authenticated.credential.oauthClientId ?? authenticated.credential.id,
					// Roles authorize resources; they must never expand the token's delegated scopes.
					scopes,
					expiresAt: authenticated.credential.expiresAt ?? Math.floor(Date.now() / 1000) + 60,
					extra: { principalId: authenticated.principal.id, principal: authenticated.principal },
				};
			},
		},
		resourceMetadataUrl: '/.well-known/oauth-protected-resource/mcp',
	});
	const publicHostname = new URL(publicBaseUrl).hostname;
	// Configure the adapter's own guard. Adding a second allowlist after its
	// localhost-only default still rejects the published API hostname first.
	const protocolApp = createMcpHonoApp({ allowedHosts: [...new Set(['127.0.0.1', 'localhost', '[::1]', publicHostname])] });
	protocolApp.post('/', async (context) => {
		const authInfo = await bearerGate(context.req.raw);
		if (authInfo instanceof Response) return authInfo;
		const principal = authInfo.extra?.principal as AuthenticatedPrincipal['principal'];
		const requestHandler = mcpBusForPrincipal
			? createControlPlaneMcpHandler(registry, confirmations, await mcpBusForPrincipal(principal))
			: mcpHandler;
		return requestHandler.fetch(context.req.raw, { parsedBody: context.get('parsedBody'), authInfo });
	});

	app.get('/openapi.json', (context) => context.json(document, 200, { 'x-treeseed-contract-digest': digest }));
	app.get('/mcp/catalog.json', (context) => context.json(mcpCatalog, 200, { 'x-treeseed-contract-digest': mcpDigest }));
	app.get('/docs', (context) => context.html(`<!doctype html><html><head><title>TreeSeed Control Plane</title></head><body><main><h1>TreeSeed Control Plane</h1><p>OpenAPI 3.1.1 contract: <a href="/openapi.json">openapi.json</a> (<code>${digest}</code>)</p><p>MCP endpoint: <code>POST /mcp</code>, protocol <code>2026-07-28</code>. <a href="/mcp/catalog.json">MCP catalog</a> (<code>${mcpDigest}</code>).</p></main></body></html>`));
	app.route('/mcp', protocolApp);

	for (const operation of registry.operations.values()) {
		const rest = operation.binding.descriptor.rest;
		if (!rest) continue;
		const honoPath = rest.path.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/gu, ':$1');
		app.on(rest.method, honoPath, createOperationHttpHandler(operation, bearerGate, digest, confirmations));
		if (operation.binding.descriptor.operationId === 'communications.send') {
			app.on(rest.method, '/v1/teams/:teamId/channels/:channel/messages', createOperationHttpHandler(operation, bearerGate, digest, confirmations));
		}
	}
	return { mcpHandler, openApiDigest: digest, mcpCatalogDigest: mcpDigest };
}
