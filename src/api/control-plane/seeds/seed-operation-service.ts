import type { OperationInvocationContext } from '../catalog/operation-registry.ts';
import { digestSeedBundle, validateSeedBundle, type SeedBundleV3 } from '@treeseed/sdk/operator-contracts';
import { applySeedWithStore, planSeedWithStore, resolveSeedResource } from '../../../control-plane/seeds/apply.js';
import { SeedOperationError } from './seed-operation-error.ts';
import { CapacityGrantService } from '../../capacity/services/capacity/allocations/grant-service.ts';
import { CapacityAllocationService } from '../../capacity/services/capacity/allocations/allocation-service.ts';
import { createHash } from 'node:crypto';

type Principal = NonNullable<OperationInvocationContext['principal']>;
type Store = {
	listSeedRuns(limit: number): Promise<Record<string, unknown>[]>;
	getSeedRun(id: string): Promise<Record<string, unknown> | null | undefined>;
	createSeedRun(input: Record<string, unknown>): Promise<Record<string, unknown>>;
	principalCanAccessTeam(principal: Principal, teamId: string): Promise<boolean>;
	principalCanManageTeam(principal: Principal, teamId: string): Promise<boolean>;
	first(query: string, params?: unknown[]): Promise<Record<string, unknown> | null>;
	all(query: string, params?: unknown[]): Promise<Record<string, unknown>[]>;
	run(query: string, params?: unknown[]): Promise<unknown>;
};
type ProviderEnrollmentService = {
	connect(principal: Principal, teamId: string, idempotencyKey: string): Promise<Record<string, unknown>>;
};

const text = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : undefined;
const environments = (value: unknown) => Array.isArray(value)
	? value.map((entry) => String(entry ?? '').trim()).filter(Boolean).join(',') || undefined
	: text(value);
const stringList = (value: unknown): string[] => {
	if (Array.isArray(value)) return value.map((entry) => String(entry ?? '').trim()).filter(Boolean);
	if (typeof value !== 'string' || !value.trim()) return [];
	try {
		const decoded = JSON.parse(value);
		return Array.isArray(decoded) ? decoded.map((entry) => String(entry ?? '').trim()).filter(Boolean) : [];
	} catch {
		return [];
	}
};
const existingTeams = (plan: any) => [...new Set<string>(plan.actions.filter((action: any) => action.kind === 'team' && action.existing?.id).map((action: any) => String(action.existing.id)))];
const createsTeams = (plan: any) => plan.actions.some((action: any) => action.kind === 'team' && action.action === 'create');
const seedAdmin = (principal: Principal) => principal.permissions?.includes('*:*:*') || principal.permissions?.includes('seeds:apply:global') || principal.roles?.includes('platform_admin');
function bundle(body: Record<string, unknown>): SeedBundleV3 {
	const value = (body.bundle ?? body) as SeedBundleV3;
	if (value && typeof value === 'object' && value.schemaVersion === 'treeseed.seed-bundle/v2') {
		throw new SeedOperationError(409, 'seed_bundle_v2_migration_required', 'Historical v2 bundles are readable receipts but must be migrated to treeseed.seed-bundle/v3 before reconciliation.');
	}
	if (!value || typeof value !== 'object' || value.schemaVersion !== 'treeseed.seed-bundle/v3') {
		throw new SeedOperationError(400, 'seed_bundle_required', 'A portable treeseed.seed-bundle/v3 bundle is required.');
	}
	return value;
}
async function validateBundle(value: SeedBundleV3) {
	const diagnostics = validateSeedBundle(value);
	const computedDigest = await digestSeedBundle(value);
	if (computedDigest !== value.digest) diagnostics.push({ code: 'seed_bundle_digest_mismatch', path: 'digest', message: 'The seed bundle digest does not match its canonical content.' });
	return { ok: diagnostics.length === 0, digest: computedDigest, diagnostics };
}
function requirePrincipal(principal: OperationInvocationContext['principal']): Principal {
	if (!principal) throw new SeedOperationError(401, 'authentication_required', 'An authenticated principal is required.');
	return principal;
}

export async function reconcileSeedProviderPrerequisites(store: Store, config: { providers?: ProviderEnrollmentService }, plan: any, mutate: boolean, principal?: Principal) {
	const grants = new CapacityGrantService(store as any);
	const allocations = new CapacityAllocationService(store as any);
	const receipts = [];
		for (const prerequisite of plan.runtime.capacityProviders ?? []) {
			const teamAction = plan.actions.find((action: any) => action.key === prerequisite.team);
			const team = teamAction?.existing ?? (teamAction ? await (store as any).getTeamBySlug(teamAction.payload.slug) : null);
			if (!team?.id) { receipts.push({ key: prerequisite.key, status: 'blocked', blockers: ['team_not_ready'] }); continue; }
			const membership = await store.first(`SELECT membership.* FROM capacity_provider_team_memberships membership
				INNER JOIN capacity_providers provider ON provider.id = membership.capacity_provider_id
				WHERE membership.team_id = ? AND membership.status = 'approved' AND provider.status = 'active'
				ORDER BY membership.approved_at DESC LIMIT 1`, [team.id]);
			if (!membership) {
				if (mutate && principal && config.providers) {
					const connectionId = `local-${team.id}`;
					const enrollment = await config.providers.connect(principal, team.id,
						`seed:${plan.seed}:${plan.version}:${prerequisite.key}:enroll`);
					receipts.push({ key: prerequisite.key, status: 'enrollment_required', teamId: team.id, connectionId,
						approval: prerequisite.approval, ...enrollment });
					continue;
				}
				receipts.push({ key: prerequisite.key, status: 'waiting_provider', teamId: team.id, blockers: ['provider_enrollment_and_owner_approval_required'] }); continue;
			}
			const session = await store.first(`SELECT * FROM capacity_provider_availability_sessions WHERE membership_id = ? AND status = 'open' AND expires_at > ? ORDER BY refreshed_at DESC LIMIT 1`, [membership.id, new Date().toISOString()]);
			if (!session) { receipts.push({ key: prerequisite.key, status: 'waiting_provider', teamId: team.id, membershipId: membership.id, blockers: ['provider_health_required'] }); continue; }
			const lanes = await store.all(`SELECT lane.*, execution_provider.capabilities_json AS execution_provider_capabilities_json FROM capacity_provider_lanes lane
				INNER JOIN capacity_execution_providers execution_provider ON execution_provider.capacity_provider_id = lane.capacity_provider_id AND execution_provider.id = lane.execution_provider_id
				WHERE lane.capacity_provider_id = ? AND lane.status = 'active' AND execution_provider.status = 'active'
				ORDER BY lane.purpose, lane.id`, [membership.capacity_provider_id]);
			const purposes = new Set(lanes.map((lane) => String(lane.purpose)));
			const missingLanes = prerequisite.requiredLanePurposes.filter((purpose: string) => !purposes.has(purpose));
			if (!lanes.length) { receipts.push({ key: prerequisite.key, status: 'waiting_provider', blockers: missingLanes.map((purpose: string) => `lane_execution_unavailable:${purpose}`) }); continue; }
			const executionProviderIds = [...new Set(lanes.map((lane) => String(lane.execution_provider_id)))];
			const capabilities = [...new Set(lanes.flatMap((lane) => stringList(lane.execution_provider_capabilities_json)))];
			const projectReceipts = [];
			const projectIds: string[] = [];
			for (const projectKey of prerequisite.projects) {
				const projectAction = plan.actions.find((action: any) => action.key === projectKey);
				const project = projectAction?.existing ?? (projectAction ? await (store as any).getProjectByTeamAndSlug(team.id, projectAction.payload.slug) : null);
				if (!project?.id) { projectReceipts.push({ projectKey, status: 'blocked', blocker: 'project_not_ready' }); continue; }
				projectIds.push(String(project.id));
				for (const environment of prerequisite.environments) {
					const existing = await store.first(`SELECT * FROM capacity_grants WHERE membership_id = ? AND project_id = ? AND environment = ? AND status IN ('planned','active','paused') LIMIT 1`, [membership.id, project.id, environment]);
					if (existing) {
						if (!mutate) { projectReceipts.push({ projectKey, environment, status: existing.status, grantId: existing.id }); continue; }
						await store.run(`UPDATE capacity_grants SET execution_provider_ids_json = ?, lane_ids_json = ?, capabilities_json = ?, updated_at = ? WHERE id = ? AND membership_id = ?`,
							[JSON.stringify(executionProviderIds), JSON.stringify(lanes.map((entry) => String(entry.id))), JSON.stringify(capabilities), new Date().toISOString(), existing.id, membership.id]);
						const active = existing.status === 'active' ? { ...existing, status: 'active' } : await grants.transition(team.id, String(existing.id), 'active', `seed:${plan.seed}:${prerequisite.key}:${project.id}:${environment}:activate`);
						projectReceipts.push({ projectKey, environment, status: active.status, grantId: existing.id }); continue;
					}
					if (!mutate) { projectReceipts.push({ projectKey, environment, status: 'planned' }); continue; }
					// Provider enrollment is replaceable. Bind both the resource identity and
					// operation receipts to the approved membership so a replacement local
					// provider cannot collide with its predecessor's sealed create receipt.
					const grantIdentity = `${plan.seed}\0${prerequisite.key}\0${membership.id}\0${project.id}\0${environment}`;
					const grantId = `seed-grant:${createHash('sha256').update(grantIdentity).digest('hex').slice(0, 32)}`;
					const candidate = await grants.create(team.id, { id: grantId, membershipId: membership.id, projectId: project.id, environment,
						executionProviderIds, laneIds: lanes.map((entry) => String(entry.id)),
						capabilities, allowedModes: prerequisite.allowedModes, unmetered: true,
						metadata: { seedName: plan.seed, seedVersion: plan.version, prerequisiteKey: prerequisite.key, manifestDigest: prerequisite.manifestDigest } }, `seed:${plan.seed}:${prerequisite.key}:${membership.id}:${project.id}:${environment}:create`);
					const active = await grants.transition(team.id, candidate.id, 'active', `seed:${plan.seed}:${prerequisite.key}:${membership.id}:${project.id}:${environment}:activate`);
					projectReceipts.push({ projectKey, environment, status: active.status, grantId: active.id });
				}
			}
			const projectsReady = projectReceipts.every((entry) => entry.status === 'active');
			let allocation: Record<string, unknown> = { status: 'waiting', blocker: 'active_allocation_required' };
			const activeAllocation = await allocations.getActive(String(team.id));
			const coversProjects = activeAllocation && projectIds.every((projectId) => activeAllocation.slices.some((slice) => slice.scope === 'project' && slice.targetId === projectId));
			if (coversProjects) allocation = { status: 'active', allocationSetId: activeAllocation.id, version: activeAllocation.version };
			else if (mutate && projectsReady && missingLanes.length === 0 && !activeAllocation) {
				const allocationSetId = `seed-allocation:${createHash('sha256').update(`${plan.seed}\0${prerequisite.key}\0${team.id}`).digest('hex').slice(0, 32)}`;
				let allocated = 0;
				const slices = projectIds.map((projectId, index) => {
					const targetPercent = index === projectIds.length - 1 ? 100 - allocated : 100 / projectIds.length;
					allocated += targetPercent;
					return { id: `seed-project:${createHash('sha256').update(`${allocationSetId}\0${projectId}`).digest('hex').slice(0, 24)}`,
						scope: 'project', targetId: projectId, policy: { minPercent: 0, targetPercent, maxPercent: 100, hardCapPercent: 100 },
						metadata: { seedName: plan.seed, seedVersion: plan.version, prerequisiteKey: prerequisite.key } };
				});
				const candidate = await allocations.create(String(team.id), { id: allocationSetId, effectiveFrom: new Date().toISOString(),
					reservePolicy: { percent: 0, overflow: 'deny' }, slices, borrowingRules: [],
					metadata: { seedName: plan.seed, seedVersion: plan.version, prerequisiteKey: prerequisite.key } }, principal?.id ?? null,
					`seed:${plan.seed}:${plan.version}:${prerequisite.key}:allocation:create`);
				const activated = await allocations.activate(String(team.id), candidate.id,
					`seed:${plan.seed}:${plan.version}:${prerequisite.key}:allocation:activate`);
				allocation = activated ? { status: 'active', allocationSetId: activated.id, version: activated.version } : allocation;
			} else if (activeAllocation) allocation = { status: 'blocked', allocationSetId: activeAllocation.id, blocker: 'active_allocation_missing_seed_projects' };
			const allocationReady = allocation.status === 'active';
			receipts.push({ key: prerequisite.key, status: projectsReady && missingLanes.length === 0 && allocationReady ? 'verified' : 'waiting_provider', teamId: team.id,
				membershipId: membership.id, providerId: membership.capacity_provider_id, sessionId: session.id, projects: projectReceipts,
				allocation,
				...(missingLanes.length ? { blockers: missingLanes.map((purpose: string) => `lane_execution_unavailable:${purpose}`) } : {}) });
		}
	return { status: receipts.every((entry) => entry.status === 'verified') ? 'verified' : receipts.some((entry) => entry.status === 'blocked') ? 'blocked' : 'waiting_provider', receipts };
}

export function createSeedOperationService(store: Store, config: { repoRoot?: string; providers?: ProviderEnrollmentService } = {}) {
	async function requirePlanAccess(principal: Principal, plan: any) {
		for (const teamId of existingTeams(plan)) if (!await store.principalCanAccessTeam(principal, teamId)) throw new SeedOperationError(403, 'seed_team_access_denied', 'The principal cannot read every team selected by this seed.');
	}
	async function requireApplyAccess(principal: Principal, plan: any) {
		await requirePlanAccess(principal, plan);
		for (const teamId of existingTeams(plan)) if (!await store.principalCanManageTeam(principal, teamId)) throw new SeedOperationError(403, 'seed_team_management_denied', 'The principal cannot manage every team selected by this seed.');
		if (createsTeams(plan) && !seedAdmin(principal)) throw new SeedOperationError(403, 'seed_global_access_denied', 'Creating teams from a seed requires seed administration access.');
	}
	async function latestSourceBundle(name: string) {
		const runs = await store.listSeedRuns(100);
		for (const run of runs) {
			if (String(run.seed_name ?? run.seedName) !== name) continue;
			const plan = run.plan && typeof run.plan === 'object' ? run.plan as Record<string, unknown> : {};
			const source = plan.sourceBundle;
			if (source && typeof source === 'object' && !Array.isArray(source)) return source as SeedBundleV3;
		}
		throw new SeedOperationError(409, 'seed_source_bundle_unavailable', 'No applied seed run retains the exact portable source bundle; apply the current bundle before verification.');
	}
	return {
		async validate(principalValue: OperationInvocationContext['principal'], body: Record<string, unknown>) {
			requirePrincipal(principalValue);
			const value = bundle(body);
			return { name: value.name, version: value.version, ...(await validateBundle(value)) };
		},
		async runs(principalValue: OperationInvocationContext['principal'], query: Record<string, unknown>) {
			requirePrincipal(principalValue);
			const limit = Math.min(100, Math.max(1, Number(query.limit ?? 50) || 50));
			return { items: await store.listSeedRuns(limit) };
		},
		async run(principalValue: OperationInvocationContext['principal'], runId: string) {
			requirePrincipal(principalValue); const run = await store.getSeedRun(runId);
			if (!run) throw new SeedOperationError(404, 'seed_run_not_found', 'The seed run was not found.');
			return run;
		},
		async plan(principalValue: OperationInvocationContext['principal'], name: string, body: Record<string, unknown>) {
			const principal = requirePrincipal(principalValue);
			const value = bundle(body);
			const validation = await validateBundle(value);
			if (!validation.ok) throw new SeedOperationError(400, 'seed_bundle_invalid', validation.diagnostics.map((entry) => entry.message).join(' '));
			const planned = await planSeedWithStore({ seedName: name, environments: environments(body.environments), mode: 'plan', store, bundle: value, actor: { actorType: 'user', principal } });
			if (!planned.plan) throw new SeedOperationError(400, 'seed_plan_invalid', 'The seed could not be planned.');
			await requirePlanAccess(principal, planned.plan);
			const run = await store.createSeedRun({ seedName: planned.plan.seed, seedVersion: planned.plan.version, environments: planned.plan.environments, mode: 'plan', state: 'completed', actorType: 'user', actorId: principal.id, manifestHash: planned.manifestHash, plan: planned.plan, result: { actionCount: planned.plan.summary.create + planned.plan.summary.update }, completedAt: new Date().toISOString() });
			return { seed: planned.plan.seed, mode: 'plan', environments: planned.plan.environments, summary: planned.plan.summary, actions: planned.plan.actions, runtime: planned.plan.runtime, diagnostics: planned.plan.diagnostics, run };
		},
		async apply(principalValue: OperationInvocationContext['principal'], name: string, body: Record<string, unknown>) {
			const principal = requirePrincipal(principalValue); const selectedEnvironments = environments(body.environments);
			const value = bundle(body);
			const validation = await validateBundle(value);
			if (!validation.ok) throw new SeedOperationError(400, 'seed_bundle_invalid', validation.diagnostics.map((entry) => entry.message).join(' '));
			const planned = await planSeedWithStore({ seedName: name, environments: selectedEnvironments, mode: 'apply', store, bundle: value, actor: { actorType: 'user', principal } });
			if (!planned.plan) throw new SeedOperationError(400, 'seed_plan_invalid', 'The seed could not be planned.');
			await requireApplyAccess(principal, planned.plan);
			let applied;
			try {
				applied = await applySeedWithStore({ seedName: name, environments: selectedEnvironments, bundle: value, approvalRequestId: text(body.approvalRequestId), store, localOnly: planned.plan.environments.length === 1 && planned.plan.environments[0] === 'local', actor: { actorType: 'user', principal } });
			} catch (error) {
				const detail = error instanceof Error && error.message.trim() ? error.message.trim() : 'Seed reconciliation failed.';
				throw new SeedOperationError(502, 'seed_reconciliation_failed', detail);
			}
			if (applied.result?.blocked === true) throw new SeedOperationError(409, 'seed_apply_blocked', String(applied.result.reason ?? 'The seed application is blocked.'));
			const providerClosure = await reconcileSeedProviderPrerequisites(store, config, applied.plan, true, principal);
			return { seed: applied.plan.seed, mode: 'apply', environments: applied.plan.environments, summary: applied.plan.summary, runtime: applied.plan.runtime, actions: applied.plan.actions, diagnostics: applied.plan.diagnostics, run: applied.run, result: { ...applied.result, providerClosure } };
		},
		async show(principalValue: OperationInvocationContext['principal'], name: string) {
			requirePrincipal(principalValue);
			const runs = await store.listSeedRuns(100);
			const run = runs.find((entry) => String(entry.seed_name ?? entry.seedName) === name);
			if (!run) throw new SeedOperationError(404, 'seed_not_found', 'No applied or planned seed record was found.');
			return run;
		},
		async verify(principalValue: OperationInvocationContext['principal'], name: string, body: Record<string, unknown>) {
			const principal = requirePrincipal(principalValue);
			const value = body.bundle || body.schemaVersion ? bundle(body) : await latestSourceBundle(name);
			const validation = await validateBundle(value);
			if (!validation.ok) throw new SeedOperationError(400, 'seed_bundle_invalid', validation.diagnostics.map((entry) => entry.message).join(' '));
			const planned = await planSeedWithStore({ seedName: name, environments: environments(body.environments), mode: 'plan', store, bundle: value, actor: { actorType: 'user', principal } });
			if (!planned.plan) throw new SeedOperationError(400, 'seed_plan_invalid', 'The seed could not be verified.');
			await requirePlanAccess(principal, planned.plan);
			const drift = planned.plan.actions.filter((action: any) => ['create', 'update', 'delete', 'error'].includes(action.action));
			const providerClosure = await reconcileSeedProviderPrerequisites(store, config, planned.plan, false);
			return { seed: name, digest: value.digest, verified: drift.length === 0 && providerClosure.status === 'verified', drift, summary: planned.plan.summary,
				providerClosure };
		},
		async reconcile(principalValue: OperationInvocationContext['principal'], name: string, body: Record<string, unknown>) {
			return this.apply(principalValue, name, body);
		},
		async resolveResources(principalValue: OperationInvocationContext['principal'], body: Record<string, unknown>) {
			const principal = requirePrincipal(principalValue);
			if (!seedAdmin(principal)) throw new SeedOperationError(403, 'seed_global_access_denied', 'Seed resource resolution requires seed administration access.');
			const keys = Array.isArray(body.keys) ? [...new Set(body.keys.map(text).filter((value): value is string => Boolean(value)))] : [];
			if (keys.length === 0 || keys.length > 500) throw new SeedOperationError(400, 'seed_resource_keys_invalid', 'keys must contain between 1 and 500 stable seed resource keys.');
			const resources = await Promise.all(keys.map((key) => resolveSeedResource(store as any, key)));
			const unresolved = keys.filter((_, index) => !resources[index]);
			if (unresolved.length) throw new SeedOperationError(409, 'seed_resources_unresolved', `Seed resources are unresolved: ${unresolved.join(', ')}.`);
			return { items: resources };
		},
	};
}
