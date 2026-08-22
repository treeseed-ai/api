import type { OperationInvocationContext } from '../catalog/operation-registry.ts';
import { applySeedWithStore, planSeedWithStore, resolveSeedResource } from '../../../control-plane/seeds/apply.js';
import { SeedOperationError } from './seed-operation-error.ts';

type Principal = NonNullable<OperationInvocationContext['principal']>;
type Store = {
	listSeedRuns(limit: number): Promise<Record<string, unknown>[]>;
	getSeedRun(id: string): Promise<Record<string, unknown> | null | undefined>;
	createSeedRun(input: Record<string, unknown>): Promise<Record<string, unknown>>;
	principalCanAccessTeam(principal: Principal, teamId: string): Promise<boolean>;
	principalCanManageTeam(principal: Principal, teamId: string): Promise<boolean>;
};

const text = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : undefined;
const environments = (value: unknown) => Array.isArray(value)
	? value.map((entry) => String(entry ?? '').trim()).filter(Boolean).join(',') || undefined
	: text(value);
const existingTeams = (plan: any) => [...new Set<string>(plan.actions.filter((action: any) => action.kind === 'team' && action.existing?.id).map((action: any) => String(action.existing.id)))];
const createsTeams = (plan: any) => plan.actions.some((action: any) => action.kind === 'team' && action.action === 'create');
const seedAdmin = (principal: Principal) => principal.permissions?.includes('*:*:*') || principal.permissions?.includes('seeds:apply:global') || principal.roles?.includes('platform_admin');
function requirePrincipal(principal: OperationInvocationContext['principal']): Principal {
	if (!principal) throw new SeedOperationError(401, 'authentication_required', 'An authenticated principal is required.');
	return principal;
}

export function createSeedOperationService(store: Store, config: { repoRoot: string }) {
	async function requirePlanAccess(principal: Principal, plan: any) {
		for (const teamId of existingTeams(plan)) if (!await store.principalCanAccessTeam(principal, teamId)) throw new SeedOperationError(403, 'seed_team_access_denied', 'The principal cannot read every team selected by this seed.');
	}
	async function requireApplyAccess(principal: Principal, plan: any) {
		await requirePlanAccess(principal, plan);
		for (const teamId of existingTeams(plan)) if (!await store.principalCanManageTeam(principal, teamId)) throw new SeedOperationError(403, 'seed_team_management_denied', 'The principal cannot manage every team selected by this seed.');
		if (createsTeams(plan) && !seedAdmin(principal)) throw new SeedOperationError(403, 'seed_global_access_denied', 'Creating teams from a seed requires seed administration access.');
	}
	return {
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
			const planned = await planSeedWithStore({ projectRoot: config.repoRoot, seedName: name, environments: environments(body.environments), manifestRef: text(body.manifestRef), mode: 'plan', store, actor: { actorType: 'user', principal } });
			if (!planned.plan) throw new SeedOperationError(400, 'seed_plan_invalid', 'The seed could not be planned.');
			await requirePlanAccess(principal, planned.plan);
			const run = await store.createSeedRun({ seedName: planned.plan.seed, seedVersion: planned.plan.version, environments: planned.plan.environments, mode: 'plan', state: 'completed', actorType: 'user', actorId: principal.id, manifestHash: planned.manifestHash, plan: planned.plan, result: { actionCount: planned.plan.summary.create + planned.plan.summary.update }, completedAt: new Date().toISOString() });
			return { seed: planned.plan.seed, mode: 'plan', environments: planned.plan.environments, summary: planned.plan.summary, actions: planned.plan.actions, runtime: planned.plan.runtime, diagnostics: planned.plan.diagnostics, run };
		},
		async apply(principalValue: OperationInvocationContext['principal'], name: string, body: Record<string, unknown>) {
			const principal = requirePrincipal(principalValue); const selectedEnvironments = environments(body.environments);
			const planned = await planSeedWithStore({ projectRoot: config.repoRoot, seedName: name, environments: selectedEnvironments, manifestRef: text(body.manifestRef), mode: 'apply', store, actor: { actorType: 'user', principal } });
			if (!planned.plan) throw new SeedOperationError(400, 'seed_plan_invalid', 'The seed could not be planned.');
			await requireApplyAccess(principal, planned.plan);
			const applied = await applySeedWithStore({ projectRoot: config.repoRoot, seedName: name, environments: selectedEnvironments, manifestRef: text(body.manifestRef), approvalRequestId: text(body.approvalRequestId), store, localOnly: planned.plan.environments.length === 1 && planned.plan.environments[0] === 'local', actor: { actorType: 'user', principal } });
			if (applied.result?.blocked === true) throw new SeedOperationError(409, 'seed_apply_blocked', String(applied.result.reason ?? 'The seed application is blocked.'));
			return { seed: applied.plan.seed, mode: 'apply', environments: applied.plan.environments, summary: applied.plan.summary, runtime: applied.plan.runtime, actions: applied.plan.actions, diagnostics: applied.plan.diagnostics, run: applied.run, result: applied.result };
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
