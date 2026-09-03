import { authorizeHostedTopologyPlan, authorizeHostedTopologyRollbackExecution, bindHostedStateBackend, hostedTopologyDeclarationSchema, hostedTopologyPlanSchema, hostedTopologyReceiptSchema, hostedTopologyRollbackExecutionSchema, hostedTopologyStateKey, planHostedTopology, planHostedTopologyRollbackExecution, type HostedResourceObservation, type HostedStateBackend, type HostedTopologyDeclaration } from '@treeseed/sdk/deployment';
import { CapacityOperationError } from '../capacity/capacity-operation-error.ts';

type Principal = { id: string; roles?: string[]; permissions?: string[] } | undefined;
export interface HostedTopologyObserver {
	observe(input: { teamId: string; declaration: HostedTopologyDeclaration; stateBackend: HostedStateBackend; connections: Record<string, Record<string, unknown>> }): Promise<HostedResourceObservation[]>;
}

async function authorize(store: any, principal: Principal, teamId: string, permission: 'infrastructure:read:team' | 'infrastructure:write:team') {
	if (!principal) throw new CapacityOperationError(401, 'authentication_required', 'Authentication is required.');
	const administrator = principal.roles?.some((role) => role === 'admin' || role === 'platform_admin') || principal.permissions?.includes('*:*:*');
	if (!administrator && !await store.principalCanAccessTeam(principal, teamId)) throw new CapacityOperationError(403, 'team_access_denied', 'The principal cannot access this team.');
	const summary = administrator ? { permissions: ['*:*:*'] } : await store.getTeamAccessSummary(teamId, principal);
	if (!administrator && !summary.permissions.includes(permission) && !summary.permissions.includes('services:manage:team')) throw new CapacityOperationError(403, 'infrastructure_permission_denied', `${permission} authority is required.`);
	return principal;
}

async function connectionByReference(store: any, teamId: string, provider: string, connectionRef: string) {
	const direct = await store.getTeamServiceConnection(teamId, connectionRef);
	if (direct) return direct;
	const matches = (await store.listTeamServiceConnections(teamId))
		.filter((connection: any) => connection.providerId === provider && connection.displayName === connectionRef);
	if (matches.length > 1) throw new CapacityOperationError(409, 'hosted_provider_connection_ambiguous',
		`More than one ${provider} connection uses portable reference ${connectionRef}.`);
	return matches[0] ?? null;
}

function etag(value?: string) { return value?.replace(/^W\//u, '').replace(/^"|"$/gu, ''); }
function rejectCredentialMaterial(value: unknown, path = 'body'): string[] {
	if (!value || typeof value !== 'object') return [];
	return Object.entries(value as Record<string, unknown>).flatMap(([key, item]) => {
		const current = `${path}.${key}`;
		if (key !== 'nonSecretConfig' && /(?:credential|password|private.?key|registration.?code|secret|token)/iu.test(key)) return [current];
		return rejectCredentialMaterial(item, current);
	});
}

async function connections(store: any, teamId: string, declaration: HostedTopologyDeclaration) {
	const selected: Record<string, Record<string, unknown>> = {};
	for (const [provider, binding] of Object.entries(declaration.providerConnections)) {
		const connection = await connectionByReference(store, teamId, provider, binding.connectionRef);
		if (!connection || connection.providerId !== provider || connection.status !== 'active') throw new CapacityOperationError(409, 'hosted_provider_connection_unavailable', `Active ${provider} connection ${binding.connectionRef} is required.`);
		selected[provider] = connection;
	}
	return selected;
}

async function stateBackend(store: any, teamId: string, declaration: HostedTopologyDeclaration) {
	const connection = await connectionByReference(store, teamId, 'cloudflare', declaration.stateBackend.connectionRef);
	if (!connection || connection.providerId !== 'cloudflare' || connection.status !== 'active') throw new CapacityOperationError(409, 'hosted_state_connection_unavailable', 'An active team Cloudflare R2 connection is required for OpenTofu state.');
	if (!connection.capabilities?.some((binding: any) => binding.capabilityType === 'object-storage' && binding.credentialProfileId === 'cloudflare-storage' && binding.status === 'configured')) throw new CapacityOperationError(409, 'hosted_state_capability_unavailable', 'The state connection must enable its isolated object-storage capability.');
	const config = connection.nonSecretConfig as Record<string, unknown> ?? {}, bucket = String(config.stateBucket ?? '').trim(), region = String(config.stateRegion ?? 'auto').trim();
	const endpoint = String(config.stateEndpoint ?? '').trim(), encryptionKeyRef = String(config.stateEncryptionKeyRef ?? '').trim();
	if (!bucket || !endpoint || !encryptionKeyRef) throw new CapacityOperationError(409, 'hosted_state_configuration_incomplete', 'The state connection requires non-secret bucket, endpoint, and encryption-key references.');
	return bindHostedStateBackend({ schemaVersion: 'treeseed.hosted-state-backend/v1', type: 's3', teamId: declaration.teamId, deploymentId: declaration.deploymentId,
		environment: declaration.environment, stackId: declaration.stackId, connectionRef: declaration.stateBackend.connectionRef, bucket,
		key: hostedTopologyStateKey(declaration), region, endpoint, usePathStyle: config.stateUsePathStyle === undefined ? true : Boolean(config.stateUsePathStyle), encryptionKeyRef });
}

function snapshots(declaration: HostedTopologyDeclaration, selected: Record<string, Record<string, unknown>>) {
	return Object.fromEntries(Object.entries(selected).map(([provider, connection]) => {
		const entries = Object.entries(connection.nonSecretConfig as Record<string, unknown> ?? {});
		if (entries.some(([, value]) => !['string', 'number', 'boolean'].includes(typeof value)))
			throw new CapacityOperationError(400, 'hosted_provider_configuration_not_scalar', `Hosted ${provider} runtime configuration must use scalar non-secret fields.`);
		const config = Object.fromEntries(entries
			.filter((entry): entry is [string, string | number | boolean] => ['string', 'number', 'boolean'].includes(typeof entry[1])));
		const forbidden = rejectCredentialMaterial(config, `connection.${provider}`);
		if (forbidden.length) throw new CapacityOperationError(400, 'plaintext_secret_rejected', `Credential-like provider configuration is forbidden: ${forbidden.join(', ')}.`);
		return [provider, { connectionRef: declaration.providerConnections[provider as keyof typeof declaration.providerConnections]!.connectionRef, nonSecretConfig: config }];
	}));
}

async function latestReceipt(store: any, teamId: string, topologyId?: string) {
	const row = await store.first(`SELECT payload_json FROM runtime_records WHERE record_type = 'hosted_topology_receipt' AND lookup_key = ?
		${topologyId ? 'AND secondary_key = ?' : ''} ORDER BY updated_at DESC LIMIT 1`, topologyId ? [teamId, topologyId] : [teamId]);
	return row ? hostedTopologyReceiptSchema.parse(JSON.parse(row.payload_json)) : null;
}

export function createHostedTopologyService(store: any, observer: HostedTopologyObserver) {
	return {
		async plan(principal: Principal, teamId: string, body: Record<string, unknown>) {
			await authorize(store, principal, teamId, 'infrastructure:read:team');
			const forbidden = rejectCredentialMaterial(body); if (forbidden.length) throw new CapacityOperationError(400, 'plaintext_secret_rejected', `Credential-like topology fields are forbidden: ${forbidden.join(', ')}.`);
			const declaration = hostedTopologyDeclarationSchema.parse(body.declaration);
			if (declaration.teamId !== teamId) throw new CapacityOperationError(403, 'hosted_topology_team_mismatch', 'Topology custody must match the authorized team.');
			const selected = await connections(store, teamId, declaration);
			const backend = await stateBackend(store, teamId, declaration), connectionSnapshots = snapshots(declaration, selected);
			const observations = await observer.observe({ teamId, declaration, stateBackend: backend, connections: connectionSnapshots });
			return planHostedTopology({ declaration, observations, connections: connectionSnapshots, stateBackend: backend });
		},
		async apply(principal: Principal, teamId: string, body: Record<string, unknown>, ifMatch?: string, idempotencyKey?: string) {
			const actor = await authorize(store, principal, teamId, 'infrastructure:write:team');
			const forbidden = rejectCredentialMaterial(body); if (forbidden.length) throw new CapacityOperationError(400, 'plaintext_secret_rejected', `Credential-like topology fields are forbidden: ${forbidden.join(', ')}.`);
			const plan = hostedTopologyPlanSchema.parse(body.plan); authorizeHostedTopologyPlan(plan, body.approval as any);
			if (plan.teamId !== teamId) throw new CapacityOperationError(403, 'hosted_topology_team_mismatch', 'Topology custody must match the authorized team.');
			if (etag(ifMatch) !== plan.planDigest) throw new CapacityOperationError(412, 'hosted_topology_plan_precondition_failed', 'If-Match must bind the exact reviewed topology plan digest.');
			return store.createPlatformOperation({ namespace: 'infrastructure', operation: 'hosted-topology-apply', target: 'control_plane_operations_runner', idempotencyKey,
				input: { teamId, plan, approval: body.approval }, requestedByType: 'user', requestedById: actor.id });
		},
		async status(principal: Principal, teamId: string) {
			await authorize(store, principal, teamId, 'infrastructure:read:team');
			const row = await store.first(`SELECT id FROM platform_operations WHERE namespace = 'infrastructure' AND input_json LIKE ? ORDER BY created_at DESC LIMIT 1`, [`%"teamId":"${teamId}"%`]);
			return { receipt: await latestReceipt(store, teamId), operation: row ? await store.findPlatformOperationById(row.id) : null };
		},
		async rollback(principal: Principal, teamId: string, body: Record<string, unknown>, ifMatch?: string, idempotencyKey?: string) {
			const actor = await authorize(store, principal, teamId, 'infrastructure:write:team');
			const execution = hostedTopologyRollbackExecutionSchema.parse(body.execution); authorizeHostedTopologyRollbackExecution(execution, body.approval as any);
			const sourcePlan = hostedTopologyPlanSchema.parse(body.sourcePlan), targetPlan = hostedTopologyPlanSchema.parse(body.targetPlan);
			const rollback = execution.rollback;
			if (etag(ifMatch) !== execution.executionDigest) throw new CapacityOperationError(412, 'hosted_topology_rollback_precondition_failed', 'If-Match must bind the exact reviewed rollback execution digest.');
			const receipt = await latestReceipt(store, teamId);
			if (!receipt || receipt.receiptId !== rollback.sourceReceiptId) throw new CapacityOperationError(409, 'hosted_topology_rollback_stale', 'Rollback must target the latest known-good topology receipt.');
			const expected = planHostedTopologyRollbackExecution({ rollback, sourceReceipt: receipt, sourcePlan, targetPlan });
			if (expected.executionDigest !== execution.executionDigest) throw new CapacityOperationError(409, 'hosted_topology_rollback_closure_mismatch', 'Rollback execution must bind the exact source receipt and source and target plans.');
			return store.createPlatformOperation({ namespace: 'infrastructure', operation: 'hosted-topology-rollback', target: 'control_plane_operations_runner', idempotencyKey,
				input: { teamId, execution, approval: body.approval, sourcePlan, targetPlan }, requestedByType: 'user', requestedById: actor.id });
		},
	};
}

export async function readLatestHostedTopologyReceipt(store: any, teamId: string, topologyId?: string) { return latestReceipt(store, teamId, topologyId); }
