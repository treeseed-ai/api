import { createMcpHonoApp, hostHeaderValidation } from '@modelcontextprotocol/hono';
import { OAuthError, OAuthErrorCode, requireBearerAuth } from '@modelcontextprotocol/server';
import type { Hono } from 'hono';
import { controlPlaneOperations } from '../catalog/index.ts';
import { createControlPlaneMcpHandler } from '../mcp/create-mcp-handler.ts';
import { mcpCatalog, mcpCatalogDigest } from '../mcp/mcp-catalog.ts';
import { generateOpenApi, openApiDigest } from '../openapi/generate-openapi.ts';

interface AuthenticatedPrincipal {
	principal: { id: string; scopes?: string[]; roles?: string[]; permissions?: string[] };
	credential: { id: string };
}

export function installControlPlaneProtocolRoutes(
	app: Hono,
	authenticateBearerToken: (token: string) => Promise<AuthenticatedPrincipal | null>,
) {
	const document = generateOpenApi(controlPlaneOperations);
	const digest = openApiDigest(document);
	const mcpDigest = mcpCatalogDigest();
	const mcpHandler = createControlPlaneMcpHandler(controlPlaneOperations);
	const bearerGate = requireBearerAuth({
		verifier: {
			async verifyAccessToken(token) {
				const authenticated = await authenticateBearerToken(token);
				if (!authenticated) throw new OAuthError(OAuthErrorCode.InvalidToken, 'The access token is invalid, expired, or revoked.');
				const admin = authenticated.principal.roles?.some((role) => ['admin', 'market_admin', 'team_owner'].includes(role))
					|| authenticated.principal.permissions?.includes('*:*:*');
				const scopes = authenticated.principal.scopes?.filter((scope) => scope.startsWith('treeseed:')) ?? [];
				return {
					token,
					clientId: authenticated.credential.id,
					scopes: admin ? ['treeseed:read', 'treeseed:knowledge:write', 'treeseed:governance:write', 'treeseed:projects:write', 'treeseed:execution', 'treeseed:admin'] : scopes.length > 0 ? scopes : ['treeseed:read'],
					expiresAt: Math.floor(Date.now() / 1000) + 60,
					extra: { principalId: authenticated.principal.id },
				};
			},
		},
		resourceMetadataUrl: '/.well-known/oauth-protected-resource/mcp',
	});
	const protocolApp = createMcpHonoApp();
	protocolApp.use('*', hostHeaderValidation(['127.0.0.1', 'localhost', '[::1]']));
	protocolApp.post('/', async (context) => {
		const authInfo = await bearerGate(context.req.raw);
		if (authInfo instanceof Response) return authInfo;
		return mcpHandler.fetch(context.req.raw, { parsedBody: context.get('parsedBody'), authInfo });
	});

	app.get('/openapi.json', (context) => context.json(document, 200, { 'x-treeseed-contract-digest': digest }));
	app.get('/mcp/catalog.json', (context) => context.json(mcpCatalog, 200, { 'x-treeseed-contract-digest': mcpDigest }));
	app.get('/docs', (context) => context.html(`<!doctype html><html><head><title>TreeSeed Control Plane</title></head><body><main><h1>TreeSeed Control Plane</h1><p>OpenAPI 3.1.1 contract: <a href="/openapi.json">openapi.json</a> (<code>${digest}</code>)</p><p>MCP endpoint: <code>POST /mcp</code>, protocol <code>2026-07-28</code>. <a href="/mcp/catalog.json">MCP catalog</a> (<code>${mcpDigest}</code>).</p></main></body></html>`));
	app.route('/mcp', protocolApp);

	for (const operation of controlPlaneOperations.operations.values()) {
		if (operation.descriptor.rest?.method !== 'GET') continue;
		app.get(operation.descriptor.rest.path, async (context) => {
			const authInfo = await bearerGate(context.req.raw);
			if (authInfo instanceof Response) return authInfo;
			const missingScope = operation.descriptor.oauthScopes.find((scope) => !authInfo.scopes.includes(scope));
			if (missingScope) return context.json({
				type: 'https://treeseed.dev/problems/insufficient-scope',
				title: 'Insufficient scope',
				status: 403,
				code: 'oauth_scope_insufficient',
				detail: `The operation requires ${missingScope}.`,
			}, 403, { 'content-type': 'application/problem+json' });
			const output = await operation.handler(operation.inputSchema.parse({}), {
				interface: 'rest',
				requestId: context.req.header('x-request-id') ?? crypto.randomUUID(),
				traceparent: context.req.header('traceparent'),
				authInfo,
			});
			return context.json({ data: operation.outputSchema.parse(output) }, 200, { 'x-treeseed-contract-digest': digest });
		});
	}
}
