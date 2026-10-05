import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import { CONTROL_PLANE_OPERATIONS } from '@treeseed/sdk/operator-contracts';
import { dependencyPoll } from './dependency-poll-fixture.ts';
import { CapacitySecretCodec } from '../../../../../../../../src/api/capacity/security.ts';
import { CapacityRegistrationService } from '../../../../../../../../src/api/capacity/services/support/registration-service.ts';
import { CapacityGovernanceRepository } from '../../../../../../../../src/api/capacity/repositories/governance/policy/governance.ts';
import { createCapacityProviderAccessMiddleware } from '../../../../../../../../src/api/capacity/provider-access-middleware.ts';
import { createProviderAssignmentService } from '../../../../../../../../src/api/control-plane/repositories/providers/provider-assignment-service.ts';
import { createProviderWorkflowService } from '../../../../../../../../src/api/control-plane/repositories/providers/provider-workflow-service.ts';
import { createProviderAssignmentOperations } from '../../../../../../../../src/api/control-plane/catalog/providers/assignments.ts';
import { OperationRegistry } from '../../../../../../../../src/api/control-plane/catalog/operation-registry.ts';
import { installControlPlaneProtocolRoutes } from '../../../../../../../../src/api/control-plane/http/protocol-routes.ts';
import { SessionEventService } from '../../../../../../../../src/api/realtime/session-events.ts';
import { createProviderRuntimeService } from '../../../../../../../../src/api/control-plane/repositories/providers/provider-runtime-service.ts';
import { createProviderRegistrationAndAvailabilityOperations } from '../../../../../../../../src/api/control-plane/catalog/providers/registration-and-availability.ts';

// Original Hono HTTP Request/Response harness, real authenticator/repositories,
// catalog, service, reconciliation, synthesis and lease SQL. No injected principal
// or lifecycle/query/HTTP-response mock. The seeded token/account/review authority
// is INPUT: issuance proof, live governance and managed dispatch remain separate.
export async function dependencyPublicPoll(runtimeKey?: { path: string; value: string }, subscriptionReady?: Promise<void>) {
	const f = await dependencyPoll();
	try {
		const secrets = runtimeKey ? new CapacitySecretCodec(createHash('sha256').update('capacity-governance:').update(runtimeKey.value).digest('hex'), runtimeKey.value)
			: new CapacitySecretCodec(randomBytes(32).toString('hex'), randomBytes(32).toString('hex'));
		const issued = secrets.issue('access');
		await f.query(`INSERT INTO capacity_provider_access_tokens
			(id,membership_id,credential_id,idempotency_key,token_prefix,token_hash,scopes_json,issued_at,expires_at,updated_at)
			VALUES ('public-poll-token','membership','supplied-credential','supplied-token-issuance',?,?,?,?,?,?)`,
		[issued.prefix, issued.hash, JSON.stringify(['provider:assignments:read']), f.now, f.attempt.deadline, f.now]);
		const authenticator = new CapacityRegistrationService(new CapacityGovernanceRepository(f.store), secrets, 'http://localhost');
		const events = new SessionEventService(f.store);
		let subscribed = 0, unsubscribed = 0;
		let observedSubscription: (() => void) | undefined;
		const subscription = new Promise<void>(resolve => { observedSubscription = resolve; });
		// Observation only; original event service owns listener storage, publication
		// and SQL. No fabricated notification or replacement event bus.
		const service = createProviderAssignmentService(f.store, { subscribe: async (teamId, listener) => {
			const release = await events.subscribe(teamId, listener); subscribed += 1; observedSubscription?.();
			// Controlled readiness barrier only; the ORIGINAL event service has
			// already acquired and owns this listener. No replacement event bus.
			await subscriptionReady;
			return () => { unsubscribed += 1; release(); };
		} });
		const registry = new OperationRegistry([...createProviderAssignmentOperations({ providerAssignments: service,
			providerWorkflows: createProviderWorkflowService(f.store) }),
			...(runtimeKey ? createProviderRegistrationAndAvailabilityOperations({ providers: createProviderRuntimeService(f.store,
				{ capacityEncryptionKeyFile: runtimeKey.path, baseUrl: 'http://localhost',
					TREESEED_CAPACITY_ENCRYPTION_KEY_VERSION: 1, TREESEED_CAPACITY_HISTORICAL_KEY_FILES: '' }, f.host) }) : [])]);
		const app = new Hono();
		app.use('/v1/provider/*', createCapacityProviderAccessMiddleware(authenticator));
		installControlPlaneProtocolRoutes(app, async () => { throw new Error('Provider polling must not invoke OAuth'); }, undefined, registry);
		const rest = CONTROL_PLANE_OPERATIONS.providers.nextAssignment.descriptor.rest;
		assert.ok(rest); assert.equal(rest.method, 'POST');
		const request = (body: Record<string, unknown> = f.request, options: { token?: string; signal?: AbortSignal; raw?: string; path?: string; method?: 'GET' | 'POST' } = {}) =>
			app.request(new Request(`http://localhost${options.path ?? rest.path}`, { method: options.method ?? rest.method,
				headers: { 'content-type': 'application/json', authorization: `Bearer ${options.token ?? issued.plaintext}`,
					'idempotency-key': 'public-poll-request' }, body: options.method === 'GET' ? undefined : options.raw ?? JSON.stringify(body), signal: options.signal }));
		const state = async () => ({ ...await f.snapshot(), invocations: (await f.query('SELECT * FROM agent_invocation_requests ORDER BY id')).rows,
			sessionEvents: (await f.query('SELECT * FROM session_events ORDER BY sequence')).rows });
		assert.ok(Date.now() < Date.parse(f.attempt.deadline), 'Original three-second public poll authority elapsed during setup');
		return { ...f, secrets, requestBody: f.request, service, registry, app, events, authenticator, request, state, subscription,
			authenticate: () => authenticator.authenticateAccessToken(issued.plaintext),
			listenerCounts: () => ({ subscribed, unsubscribed }) };
	} catch (error) { await f.db.close(); throw error; }
}
