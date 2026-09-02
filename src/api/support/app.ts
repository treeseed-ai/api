import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { PostgresAuthProvider } from '../auth/postgres-provider.ts';
import { createCapacityControlPlane } from '../capacity/control-plane.ts';
import { createApiControlPlaneOperations } from '../control-plane/catalog/index.ts';
import { installControlPlaneProtocolRoutes } from '../control-plane/http/protocol-routes.ts';
import { ConfirmationService } from '../control-plane/confirmation/confirmation-service.ts';
import { createAccountEmailService } from '../control-plane/accounts/account-email-service.ts';
import { createAccountRegistrationService } from '../control-plane/accounts/account-registration-service.ts';
import { createAccountSecurityService } from '../control-plane/accounts/account-security-service.ts';
import { createKnowledgeReaderService } from '../control-plane/knowledge/knowledge-reader-service.ts';
import { createKnowledgeWorkspaceService } from '../control-plane/knowledge/knowledge-workspace-service.ts';
import { createKnowledgeReviewService } from '../control-plane/knowledge/knowledge-review-service.ts';
import { createDiscussionService } from '../discussions/discussion-service.ts';
import { createGovernanceService } from '../control-plane/governance/governance-service.ts';
import { createInboxService } from '../control-plane/inbox/inbox-service.ts';
import { createProjectRepositoryService } from '../control-plane/repositories/project-repository-service.ts';
import { createPlatformProjectCreationService } from '../control-plane/projects/platform-project-creation-service.ts';
import { createWorkflowService } from '../control-plane/repositories/workflow-service.ts';
import { createWorkflowConfigurationService } from '../control-plane/repositories/workflow-configuration-service.ts';
import { createGitHubConnectorService } from '../control-plane/repositories/github-connector-service.ts';
import { createGitHubWebhookService } from '../control-plane/repositories/github-webhook-service.ts';
import { createServiceConnectionService } from '../control-plane/repositories/service-connection-service.ts';
import { createHostedTopologyService } from '../control-plane/repositories/infrastructure/hosted-topology-service.ts';
import { createHostedProviderAdapter } from '../../operations-runner/infrastructure/hosted-provider-adapter.ts';
import { createCapacityPlanService } from '../control-plane/repositories/capacity/capacity-plan-service.ts';
import { createPlanningAndEstimateService } from '../control-plane/repositories/capacity/planning-and-estimate-service.ts';
import { createAgentGovernanceService } from '../control-plane/repositories/capacity/agent-governance-service.ts';
import { createCommunicationService } from '../control-plane/repositories/capacity/communication-service.ts';
import { createDiagnosticEnvelopeService } from '../../security/diagnostic-envelope.ts';
import { createWorkdayService } from '../control-plane/repositories/capacity/workday-service.ts';
import { createAgentQueryService } from '../control-plane/repositories/capacity/agent-query-service.ts';
import { createCapacityQueryService } from '../control-plane/repositories/capacity/capacity-query-service.ts';
import { createAssignmentService } from '../control-plane/repositories/capacity/assignment-service.ts';
import { createOperationService } from '../control-plane/repositories/operations/operation-service.ts';
import { createProviderRuntimeService } from '../control-plane/repositories/providers/provider-runtime-service.ts';
import { createProviderAssignmentService } from '../control-plane/repositories/providers/provider-assignment-service.ts';
import { createProviderSignalService } from '../control-plane/repositories/providers/provider-signal-service.ts';
import { createProviderWorkflowService } from '../control-plane/repositories/providers/provider-workflow-service.ts';
import { createTreeDxProxyOperationService } from '../control-plane/repositories/treedx/proxy-operation-service.ts';
import { environmentTreeAiNodeResolver, TreeAiProxyService } from '../control-plane/treeai/proxy-service.ts';
import { treeDxDelegationAuthority } from '../control-plane/treedx/delegation-authority.ts';
import { installRemoteCredentialBrokerRoute } from '../control-plane/treedx/remote-credential-broker.ts';
import { createRealtimeOperationService } from '../control-plane/realtime/realtime-operation-service.ts';
import { createSeedOperationService } from '../control-plane/seeds/seed-operation-service.ts';
import { createFeedbackOperationService } from '../control-plane/feedback/feedback-operation-service.ts';
import { createCapabilityOntologyService } from '../control-plane/repositories/capabilities/capability-ontology-service.ts';
import { createCapacityProviderAccessMiddleware } from '../capacity/provider-access-middleware.ts';
import { ControlPlaneStore } from '../persistence/store.js';
import { SessionEventService } from '../realtime/session-events.ts';
import { SessionEventMcpBus } from '../control-plane/mcp/session-event-bus.ts';
import {
	defaultConfig,
	installApiRequestLogger,
	resolveAgentArtifactBucket,
	resolveAuthApprovalBaseUrl,
	shouldLogApiRequests,
} from '../app/support/index.ts';
import { createControlPlanePostgresDatabase } from './control-plane-postgres.js';
import { listUserEmailAddresses, sendTeamInviteEmail } from '../app/support/accounts/authentication-email.ts';
import { deleteManagedTeamLibraryResources,reconcileManagedTeamLibrary } from '../teams/managed-team-library-service.ts';

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
	const delegationAuthority = options.treeDxDelegationAuthority ?? treeDxDelegationAuthority();
	const capacity = createCapacityControlPlane(store);
	const hostedTopologyObserver = options.hostedTopologyObserver ?? createHostedProviderAdapter({ store, fetchImpl: options.fetchImpl });
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
		treeDxDelegationAuthority: delegationAuthority,
		fetchImpl: options.fetchImpl ?? fetch,
		internalPrefix: options.internalPrefix ?? '/internal/core',
	};
	const app = new Hono();
	app.get('/.well-known/treedx-jwks.json', (context) => context.json(delegationAuthority.jwks(), 200, {
		'cache-control': 'public, max-age=60, stale-while-revalidate=300',
	}));

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
	app.use('/v1/*', async (context, next) => {
		const token = bearerToken(context.req.raw);
		if (!context.get('principal') && token) {
			const match = await store.authenticateTeamApiKey(token);
			if (match) setAuthentication(context, {
				principal: match.principal,
				credential: { type: 'team_api_key', id: match.keyId, label: 'Team API Key' },
			}, 'service');
		}
		await next();
	});
	const providers = createProviderRuntimeService(capacity, { ...config, ...runtime.resolved.config }, store);
	const capabilityOntology = createCapabilityOntologyService(capacity);
	const diagnosticEnvelopes = createDiagnosticEnvelopeService({ ...config, ...runtime.resolved.config });
	const providerAssignments = createProviderAssignmentService(capacity, sessionEvents, store, diagnosticEnvelopes);
	const providerSignals = createProviderSignalService(capacity);
	const providerWorkflows = createProviderWorkflowService(capacity);
	const treeDxProxy = createTreeDxProxyOperationService(capacity, runtime);
	const treeAiProxy = new TreeAiProxyService(environmentTreeAiNodeResolver(process.env), options.fetchImpl ?? fetch);
	const providerAccess = createCapacityProviderAccessMiddleware(providers.authenticator);
	app.use('/v1/provider/*', providerAccess);
	app.use('/v1/dx/*', providerAccess);
	installRemoteCredentialBrokerRoute(app, { store, env: process.env, fetchImpl: options.fetchImpl ?? fetch });
	const invitationContext = { locals: { runtime: { env: { ...process.env,
		TREESEED_SITE_URL: String(config.siteUrl ?? resolveAuthApprovalBaseUrl(config)) } } },
		url: new URL(String(config.siteUrl ?? resolveAuthApprovalBaseUrl(config))) };
	const accountRegistration = createAccountRegistrationService(store, authProvider, invitationContext);
	const knowledgeReader = createKnowledgeReaderService({ store, options });
	const discussions = createDiscussionService({ store, capacity, sessionEvents });
	const communications = createCommunicationService(capacity, discussions, store, diagnosticEnvelopes);
	const governance = createGovernanceService(store);
	const inbox = createInboxService({ store, discussions, communications, governance });
	installControlPlaneProtocolRoutes(app, (token) => authProvider.authenticateBearerToken(token), authProvider,
		createApiControlPlaneOperations({ store, capacity,
			hostedTopology: createHostedTopologyService(store, hostedTopologyObserver),
			platformProjectCreation: createPlatformProjectCreationService(store, { env: process.env, fetchImpl: options.fetchImpl ?? fetch }),
			capabilityOntology,
			plans: createCapacityPlanService(capacity),
			planningAndEstimates: createPlanningAndEstimateService(capacity),
			agentGovernance: createAgentGovernanceService(capacity),
			communications,
			inbox,
			workdays: createWorkdayService(capacity),
			agents: createAgentQueryService(capacity),
			capacityQueries: createCapacityQueryService(capacity),
			assignments: createAssignmentService(capacity),
			platformOperations: createOperationService(store),
			providers,
			providerAssignments,
			providerSignals,
			providerWorkflows,
			treeDxProxy,
			treeAiProxy,
			realtime: createRealtimeOperationService(store, sessionEvents),
			seeds: createSeedOperationService(store, { providers }),
			feedback: createFeedbackOperationService(store, options),
			githubConnector: createGitHubConnectorService(store),
			githubWebhook: createGitHubWebhookService(store),
			services: createServiceConnectionService(store),
			deliverTeamInvite: (input) => sendTeamInviteEmail(invitationContext, input),
			reconcileManagedTeamLibrary: (teamId) => reconcileManagedTeamLibrary(store,teamId,process.env),
			deleteManagedTeamLibraryResources: (input) => deleteManagedTeamLibraryResources({...input,env:process.env,fetchImpl:options.fetchImpl??fetch}),
			listUserEmailAddresses: (userId) => listUserEmailAddresses(store, userId),
			accountEmails: createAccountEmailService(store, invitationContext),
			accountRegistration,
			accountSecurity: createAccountSecurityService(store, invitationContext),
			knowledgeReader,
			knowledgeWorkspaces: createKnowledgeWorkspaceService(store, knowledgeReader),
			knowledgeReviews: createKnowledgeReviewService(store),
			discussions,
			governance,
			repositories: createProjectRepositoryService(store),
			workflows: createWorkflowService(store),
			workflowConfiguration: createWorkflowConfigurationService(store),
		}), confirmations, async (principal) => {
			const teams = await store.listTeamsForPrincipal(principal);
			return new SessionEventMcpBus(sessionEvents, teams.map((team) => String(team.id)).filter(Boolean));
		}, config.baseUrl, String(config.siteUrl ?? resolveAuthApprovalBaseUrl(config)));
	for (const extension of options.extensions ?? []) extension.mount?.(app, runtime);
	options.extendApp?.(app, runtime);
	app.notFound((context) => context.json({ ok: false, error: 'Not found.', requestId: context.get('requestId') }, 404));
	return app;
}
