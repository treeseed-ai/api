import { createMcpHonoApp, hostHeaderValidation } from '@modelcontextprotocol/hono';
import { OAuthError, OAuthErrorCode, requireBearerAuth } from '@modelcontextprotocol/server';
import type { Hono } from 'hono';
import { controlPlaneOperations } from '../catalog/index.ts';
import type { OperationRegistry } from '../catalog/operation-registry.ts';
import { createControlPlaneMcpHandler } from '../mcp/create-mcp-handler.ts';
import { createMcpCatalog, mcpCatalogDigest } from '../mcp/mcp-catalog.ts';
import { generateOpenApi, openApiDigest } from '../openapi/generate-openapi.ts';
import { installOAuthProtocolRoutes, type OAuthRuntimeProvider } from '../oauth/oauth-routes.ts';
import { createOperationHttpHandler } from './operation-http-handler.ts';
import type { ConfirmationService } from '../confirmation/confirmation-service.ts';

interface AuthenticatedPrincipal {
	principal: { id: string; scopes?: string[]; roles?: string[]; permissions?: string[] };
	credential: { id: string };
}

export function installControlPlaneProtocolRoutes(
	app: Hono,
	authenticateBearerToken: (token: string) => Promise<AuthenticatedPrincipal | null>,
	oauthProvider?: OAuthRuntimeProvider,
	registry: OperationRegistry = controlPlaneOperations,
	confirmations?: ConfirmationService,
) {
	const document = generateOpenApi(registry);
	const digest = openApiDigest(document);
	const mcpCatalog = createMcpCatalog(registry);
	const mcpDigest = mcpCatalogDigest(mcpCatalog);
	const mcpHandler = createControlPlaneMcpHandler(registry, confirmations);
	const bearerGate = requireBearerAuth({
		verifier: {
			async verifyAccessToken(token) {
				const authenticated = await authenticateBearerToken(token);
				if (!authenticated) throw new OAuthError(OAuthErrorCode.InvalidToken, 'The access token is invalid, expired, or revoked.');
				const admin = authenticated.principal.roles?.some((role) => ['admin', 'platform_admin', 'team_owner'].includes(role))
					|| authenticated.principal.permissions?.includes('*:*:*');
				const scopes = authenticated.principal.scopes?.filter((scope) => scope.startsWith('treeseed:')) ?? [];
				return {
					token,
					clientId: authenticated.credential.id,
					scopes: admin ? ['treeseed:read', 'treeseed:knowledge:write', 'treeseed:governance:write', 'treeseed:projects:write', 'treeseed:execution', 'treeseed:admin'] : scopes.length > 0 ? scopes : ['treeseed:read'],
					expiresAt: Math.floor(Date.now() / 1000) + 60,
					extra: { principalId: authenticated.principal.id, principal: authenticated.principal },
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
	installOAuthProtocolRoutes(app, oauthProvider);
	app.route('/mcp', protocolApp);

	for (const operation of registry.operations.values()) {
		const rest = operation.binding.descriptor.rest;
		if (!rest) continue;
		const honoPath = rest.path.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/gu, ':$1');
		app.on(rest.method, honoPath, createOperationHttpHandler(operation, bearerGate, digest, confirmations));
	}
}
