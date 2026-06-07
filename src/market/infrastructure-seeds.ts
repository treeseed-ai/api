import { existsSync, readdirSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { planSeedWithStore } from './seeds/apply.js';

export interface InfrastructureSeedInput {
	store: any;
	team: any | null;
	principal?: any;
	locals?: App.Locals;
	url?: URL;
}

export async function loadInfrastructureSeedState(input: InfrastructureSeedInput): Promise<any> {
	if (!input.team || !input.store) {
		return emptySeedState('Team store is unavailable.');
	}

	const projectRoot = projectRootFor(input.locals);
	const seedNames = discoverSeedNames(projectRoot);
	const selectedSeed = selectedSeedName(input.url, seedNames);
	const selectedEnvironments = selectedSeedEnvironment(input.url, input.locals);
	const planned: any = await planSeedWithStore({
		projectRoot,
		seedName: selectedSeed,
		environments: selectedEnvironments,
		mode: 'plan',
		store: input.store,
		actor: {
			actorType: 'user',
			principal: input.principal,
		},
	}).catch((error: unknown) => ({
		plan: null,
		diagnostics: [{
			severity: 'error',
			code: 'seed.plan_failed',
			message: error instanceof Error ? error.message : String(error),
			path: 'seed',
		}],
		manifestHash: null,
	}));

	const [runs, approvals] = await Promise.all([
		typeof input.store.listSeedRuns === 'function' ? input.store.listSeedRuns(100).catch(() => []) : [],
		typeof input.store.listApprovalRequestsForTeam === 'function'
			? input.store.listApprovalRequestsForTeam(input.team.id, { kind: 'seed_production_apply', limit: 50 }).catch(() => [])
			: [],
	]);

	return {
		teamId: input.team.id,
		seedNames,
		selectedSeed,
		selectedEnvironments,
		plan: planned.plan,
		diagnostics: planned.plan?.diagnostics ?? planned.diagnostics ?? [],
		manifestHash: planned.manifestHash ?? null,
		runs: safeArray(runs).filter((run: any) => seedRunTouchesTeam(run, input.team)).slice(0, 20),
		approvals,
		error: null,
	};
}

function emptySeedState(error: string) {
	return {
		teamId: null,
		seedNames: ['treeseed'],
		selectedSeed: 'treeseed',
		selectedEnvironments: 'local',
		plan: null,
		diagnostics: [],
		manifestHash: null,
		runs: [],
		approvals: [],
		error,
	};
}

function runtimeEnvValue(locals: App.Locals | undefined, name: string) {
	const runtimeValue = (locals as any)?.runtime?.env?.[name];
	if (typeof runtimeValue === 'string' && runtimeValue.trim()) return runtimeValue.trim();
	const processValue = typeof process !== 'undefined' ? process.env?.[name] : undefined;
	return typeof processValue === 'string' && processValue.trim() ? processValue.trim() : '';
}

function isLocalRuntime(locals: App.Locals | undefined) {
	return runtimeEnvValue(locals, 'TREESEED_ENVIRONMENT') === 'local'
		|| runtimeEnvValue(locals, 'TREESEED_LOCAL_DEV_MODE') === 'cloudflare';
}

function projectRootFor(locals: App.Locals | undefined) {
	const repoRoot = (locals as any)?.runtime?.resolved?.config?.repoRoot;
	return typeof repoRoot === 'string' && repoRoot.trim() ? repoRoot : process.cwd();
}

function discoverSeedNames(projectRoot: string) {
	const seedsDir = resolve(projectRoot, 'seeds');
	if (!existsSync(seedsDir)) return ['treeseed'];
	const names = readdirSync(seedsDir)
		.filter((entry) => entry.endsWith('.yaml') || entry.endsWith('.yml'))
		.map((entry) => basename(entry).replace(/\.ya?ml$/u, ''))
		.filter((entry) => /^[a-zA-Z0-9_-]+$/u.test(entry));
	return [...new Set(names.length ? names : ['treeseed'])].sort((left, right) => {
		if (left === 'treeseed') return -1;
		if (right === 'treeseed') return 1;
		return left.localeCompare(right);
	});
}

function selectedSeedEnvironment(url: URL | undefined, locals: App.Locals | undefined) {
	const requested = url?.searchParams.get('environments') ?? url?.searchParams.get('environment') ?? '';
	if (requested.trim()) return requested;
	return isLocalRuntime(locals) ? 'local' : 'staging';
}

function selectedSeedName(url: URL | undefined, seedNames: string[]) {
	const requested = url?.searchParams.get('seed') ?? '';
	return seedNames.includes(requested) ? requested : seedNames.includes('treeseed') ? 'treeseed' : seedNames[0] ?? 'treeseed';
}

function seedRunTouchesTeam(run: any, team: any) {
	const actions = Array.isArray(run?.plan?.actions) ? run.plan.actions : [];
	const handles = new Set([team?.id, team?.name, team?.slug].filter(Boolean).map(String));
	return actions.some((action: any) => (
		action.kind === 'team'
		&& (
			handles.has(String(action.existing?.id ?? ''))
			|| handles.has(String(action.payload?.slug ?? ''))
			|| handles.has(String(action.payload?.name ?? ''))
		)
	));
}

function safeArray<T = any>(value: unknown): T[] {
	return Array.isArray(value) ? value as T[] : [];
}
