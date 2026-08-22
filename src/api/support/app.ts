import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { PostgresAuthProvider } from '../auth/postgres-provider.ts';
import { createCapacityControlPlane } from '../capacity/control-plane.ts';
import { createApiControlPlaneOperations } from '../control-plane/catalog/index.ts';
import { installControlPlaneProtocolRoutes } from '../control-plane/http/protocol-routes.ts';
import { ConfirmationService } from '../control-plane/confirmation/confirmation-service.ts';
import { createAccountEmailService } from '../control-plane/accounts/account-email-service.ts';
import { ControlPlaneStore } from '../persistence/store.js';
import { SessionEventService } from '../realtime/session-events.ts';
import {
	defaultConfig,
	installApiRequestLogger,
	resolveAgentArtifactBucket,
	resolveAuthApprovalBaseUrl,
	shouldLogApiRequests,
} from '../app/support/index.ts';
import { createControlPlanePostgresDatabase } from './control-plane-postgres.js';
import { routeDependencies } from './route-dependencies.ts';
import { installPlatformRoutes } from './route-installers.ts';

export * from '../app/support/index.ts';

function bearerToken(request: Request) {
	return request.headers.get('authorization')?.match(/^Bearer\s+(.+)$/iu)?.[1] ?? null;
}

function sameSecret(left: string, right: string | undefined) {
	if (!right) return false;
	const leftBuffer = Buffer.from(left);
	const rightBuffer = Buffer.from(right);
	return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function projectPrincipal(config: any) {
	return {
		id: `project:${config.projectId}`,
		displayName: config.projectApiLabel,
		roles: ['project_api'],
		permissions: [...(config.projectApiPermissions ?? [])],
		scopes: ['auth:me'],
		metadata: { projectId: config.projectId },
	};
}

function authProviderFor(options: any, config: any, db: any) {
	const id = config.providers?.auth ?? 'control-plane-postgres';
	const factory = options.runtimeProviders?.auth?.[id];
	if (factory) return factory({ config });
	if (id !== 'control-plane-postgres') throw new Error(`TreeSeed API runtime could not resolve auth provider "${id}".`);
	return new PostgresAuthProvider({ ...config, baseUrl: resolveAuthApprovalBaseUrl(config) }, { db });
}

function setAuthentication(context: any, result: any, actorType?: string) {
	context.set('principal', result.principal);
	context.set('credential', result.credential);
	context.set('actorType', actorType ?? (result.credential?.type === 'service_token' ? 'service' : 'user'));
	context.set('permissionGrants', result.principal?.permissions ?? []);
}

export function createPlatformApiApp(options: any = {}) {
	const config = defaultConfig(options.config ?? {});
	const apiDatabaseUrl = config.apiDatabaseUrl ?? process.env.TREESEED_DATABASE_URL ?? null;
	if (!options.db && !apiDatabaseUrl) throw new Error('TREESEED_DATABASE_URL is required for the TreeSeed PostgreSQL control-plane database.');
	const db = options.db ?? createControlPlanePostgresDatabase(apiDatabaseUrl);
	const store = options.store ?? new ControlPlaneStore({
		...config,
		assertionSecret: config.webAssertionSecret,
		serviceId: config.webServiceId,
		serviceSecret: config.webServiceSecret,
		fetchImpl: options.fetchImpl ?? fetch,
	}, db);
	const authProvider = authProviderFor(options, config, db);
	const capacity = createCapacityControlPlane(store);
	const sessionEvents = options.sessionEvents ?? new SessionEventService(store, db.pool);
	const confirmations = new ConfirmationService(config.authSecret, {
		async consume(nonce, claims) {
			await store.run('DELETE FROM operation_confirmation_nonces WHERE expires_at <= ?', [new Date().toISOString()]);
			try {
				await store.run(`INSERT INTO operation_confirmation_nonces
					(nonce, principal_id, client_id, operation_id, arguments_digest, expires_at, consumed_at)
					VALUES (?, ?, ?, ?, ?, ?, ?)`, [nonce, claims.principalId, claims.clientId, claims.operationId,
					claims.argumentsDigest, claims.expiresAt, new Date().toISOString()]);
				return true;
			} catch { return false; }
		},
	});
	const runtimeProviders = {
		auth: authProvider,
		selections: { auth: config.providers?.auth ?? 'control-plane-postgres', agents: config.providers?.agents ?? {} },
	};
	const runtime = {
		resolved: { config, surfaces: { auth: true, templates: false, sdk: false, operations: false, ...(options.surfaces ?? {}) } },
		runtimeProviders,
		internalPrefix: options.internalPrefix ?? '/internal/core',
	};
	const app = new Hono();

	app.use('*', async (context, next) => {
		context.set('requestId', context.req.header('x-request-id')?.trim() || randomUUID());
		context.set('config', config);
		context.set('principal', null);
		context.set('actingUser', null);
		context.set('credential', null);
		context.set('actorType', 'anonymous');
		context.set('permissionGrants', []);
		await next();
	});

	app.use('*', async (context, next) => {
		const serviceId = context.req.header('x-treeseed-service-id');
		const serviceSecret = context.req.header('x-treeseed-service-secret');
		if (serviceId && serviceSecret && typeof authProvider.authenticateServiceCredential === 'function') {
			const authenticated = await authProvider.authenticateServiceCredential(serviceId, serviceSecret);
			if (!authenticated) return context.json({ ok: false, error: 'Invalid internal service credential.' }, 401);
			setAuthentication(context, authenticated, 'service');
		}
		await next();
	});

	app.use('*', async (context, next) => {
		const token = bearerToken(context.req.raw);
		if (token) {
			if (sameSecret(token, config.projectApiKey)) {
				setAuthentication(context, { principal: projectPrincipal(config), credential: { type: 'project_api_key', id: config.projectId, label: config.projectApiLabel } }, 'project');
			} else if (typeof authProvider.authenticateBearerToken === 'function') {
				const authenticated = await authProvider.authenticateBearerToken(token);
				if (authenticated) setAuthentication(context, authenticated);
			}
		}
		await next();
	});

	app.use('*', async (context, next) => {
		const assertion = context.req.header('x-treeseed-user-assertion');
		if (assertion && context.get('actorType') === 'service' && typeof authProvider.verifyTrustedUserAssertion === 'function') {
			const claims = authProvider.verifyTrustedUserAssertion(assertion);
			if (!claims) return context.json({ ok: false, error: 'Invalid trusted user assertion.' }, 401);
			const exchange = await authProvider.exchangeTrustedUserAssertion(claims);
			context.set('actingUser', exchange.principal);
			setAuthentication(context, { principal: exchange.principal, credential: context.get('credential') }, 'user');
		}
		await next();
	});

	if (shouldLogApiRequests(config, options)) installApiRequestLogger(app);
	store.setArtifactBucket(resolveAgentArtifactBucket(runtime));
	const routeContext = {
		...routeDependencies,
		apiDatabaseUrl,
		app,
		authConfig: { ...config, baseUrl: resolveAuthApprovalBaseUrl(config) },
		authProviderId: config.providers?.auth ?? 'control-plane-postgres',
		capacity,
		config,
		configuredAuthProviderId: config.providers?.auth ?? 'control-plane-postgres',
		db,
		logRequests: shouldLogApiRequests(config, options),
		options,
		runtime,
		runtimeControlPlaneAuthProvider: authProvider,
		runtimeProviders,
		sessionEvents,
		store,
	};
	installPlatformRoutes(routeContext);
	const invitationContext = { locals: { runtime: { env: { ...process.env,
		TREESEED_SITE_URL: String(config.siteUrl ?? resolveAuthApprovalBaseUrl(config)) } } },
		url: new URL(String(config.siteUrl ?? resolveAuthApprovalBaseUrl(config))) };
	installControlPlaneProtocolRoutes(app, (token) => authProvider.authenticateBearerToken(token), authProvider,
		createApiControlPlaneOperations({ store, capacity,
			deliverTeamInvite: (input) => routeDependencies.sendTeamInviteEmail(invitationContext, input),
			listUserEmailAddresses: (userId) => routeDependencies.listUserEmailAddresses(store, userId),
			accountEmails: createAccountEmailService(store, invitationContext),
		}), confirmations);
	for (const extension of options.extensions ?? []) extension.mount?.(app, runtime);
	options.extendApp?.(app, runtime);
	app.notFound((context) => context.json({ ok: false, error: 'Not found.', requestId: context.get('requestId') }, 404));
	return app;
}
