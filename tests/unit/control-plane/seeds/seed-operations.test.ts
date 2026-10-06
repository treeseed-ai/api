import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { CONTROL_PLANE_OPERATIONS, digestSeedBundle } from '@treeseed/sdk/operator-contracts';
import { createSeedOperations } from '../../../../src/api/control-plane/catalog/seeds/index.ts';
import { createSeedOperationService, reconcileSeedProviderPrerequisites } from '../../../../src/api/control-plane/seeds/seed-operation-service.ts';
import { validateSeedSource } from '../../../../src/control-plane/seeds/contracts/index.ts';
import { actionIsUnchanged, ensureLocalSeedTeamMemberships } from '../../../../src/control-plane/seeds/apply-support/index.ts';
import { applyPlannedSeedActions } from '../../../../src/control-plane/seeds/apply-support/support/apply.ts';
import { parseRecipeCommand } from '../../../../src/control-plane/seeds/contracts/schema/parse-project.ts';
import { loadAndPlanCoreSeed } from '../../../../src/control-plane/seeds/planning/load-core-seed-plan.ts';
import { createProductionApproval } from '../../../../src/control-plane/seeds/apply-support/governance/production-approval.ts';
import { ControlPlaneStore, serializeApprovalRequest } from '../../../../src/api/persistence/store.ts';
import { postgresGraph } from '../capacity/execution/graph/architecture/living/living-postgres-fixture.ts';
import type { SeedDiagnostic } from '../../../../src/control-plane/seeds/contracts/types.ts';

describe('seed catalog operations', () => {
	it('execution seed approval denies missing owning read-back before inbox publication and preserves exact successful inputs', async () => {
		const plan = { seed: 'execution', version: 1, environments: ['prod'],
			summary: { create: 1, update: 2, unchanged: 3, skip: 0, delete: 0, error: 0 }, actions: [
				{ kind: 'team', key: 'team:execution', payload: { slug: 'execution' }, existing: { id: 'team', slug: 'execution' } },
				{ kind: 'project', key: 'project:execution/agent', payload: { teamKey: 'team:execution', slug: 'agent' }, existing: { id: 'project', slug: 'agent' } },
			] };
		const input = { plan, manifestHash: 'held-manifest', actor: { actorType: 'user', id: 'operator' } }, before = structuredClone(input);
		const request = serializeApprovalRequest({ id: 'approval', title: 'Exact approval', summary: 'Exact summary', kind: 'seed_production_apply' });
		const store = { createApprovalRequest: vi.fn(async () => request), upsertTeamInboxItem: vi.fn(async () => null) };
		store.createApprovalRequest.mockResolvedValueOnce(null);
		await expect(createProductionApproval({ ...input, store })).resolves.toEqual({ ok: false, message: 'Production seed approval request could not be read back.' });
		expect(store.upsertTeamInboxItem).not.toHaveBeenCalled();
		expect(input).toEqual(before);
		await expect(createProductionApproval({ ...input, store })).resolves.toEqual({ ok: true, approvalRequest: request });
		expect(store.createApprovalRequest.mock.calls).toHaveLength(2);
		expect(store.upsertTeamInboxItem).toHaveBeenCalledExactlyOnceWith('team', {
			id: 'seed-approval:approval', projectId: 'project', kind: 'approval', state: 'waiting_for_approval',
			title: 'Exact approval', summary: 'Exact summary', href: '/app/work/decisions#approval-approval', itemKey: 'approval',
			metadata: { approvalId: 'approval', approvalRequestId: 'approval', approvalKind: 'seed_production_apply',
				seed: { name: 'execution', version: 1, environments: ['prod'], manifestHash: 'held-manifest', planSummary: plan.summary } },
		});
		expect(input).toEqual(before);
	});
	it('native execution seed approval retains interrupted PostgreSQL rows without a false inbox and independently reads a fresh exact retry', async () => {
		const f = await postgresGraph();
		try {
			const store = new ControlPlaneStore({ TREESEED_ENVIRONMENT: 'test' }, f.left);
			store.initializationPromise = Promise.resolve();
			const plan = { seed: 'execution', version: 1, environments: ['prod'],
				summary: { create: 1, update: 2, unchanged: 3, skip: 0, delete: 0, error: 0 }, actions: [
					{ kind: 'team', key: 'team:execution', payload: { slug: 'execution' }, existing: { id: 'team', slug: 'execution' } },
					{ kind: 'project', key: 'project:execution/agent', payload: { teamKey: 'team:execution', slug: 'agent' }, existing: { id: 'project', slug: 'agent' } },
				] };
			const input = { plan, manifestHash: 'held-manifest', actor: { actorType: 'user', id: 'operator' } }, before = structuredClone(input);
			// Native fault input moves only the newly inserted identifier. The real
			// owning read cannot find it; its original failed row remains retained.
			await f.left.pool.query(`CREATE FUNCTION interrupted_seed_approval() RETURNS trigger LANGUAGE plpgsql AS $$
				BEGIN NEW.id := 'interrupted-' || NEW.id; RETURN NEW; END $$;
				CREATE TRIGGER interrupted_seed_approval BEFORE INSERT ON approval_requests FOR EACH ROW EXECUTE FUNCTION interrupted_seed_approval()`);
			await expect(createProductionApproval({ ...input, store })).resolves.toEqual({ ok: false, message: 'Production seed approval request could not be read back.' });
			const failed = (await f.right.pool.query('SELECT * FROM approval_requests ORDER BY id')).rows;
			expect(failed).toHaveLength(1);
			expect(failed[0].id).toMatch(/^interrupted-/u);
			expect(failed[0]).toMatchObject({ team_id: 'team', project_id: 'project', state: 'pending', kind: 'seed_production_apply', requested_by_id: 'operator' });
			expect((await f.right.pool.query('SELECT * FROM team_inbox_items')).rows).toEqual([]);
			expect(await f.snapshot()).toEqual({ nodes: [], edges: [], revisions: [], assignments: [], reservations: [] });
			await f.left.pool.query('DROP TRIGGER interrupted_seed_approval ON approval_requests; DROP FUNCTION interrupted_seed_approval()');
			const result = await createProductionApproval({ ...input, store });
			expect(result.ok).toBe(true);
			if (!('approvalRequest' in result) || !result.approvalRequest) throw new Error('Exact owning approval read-back missing');
			const rows = (await f.right.pool.query('SELECT * FROM approval_requests ORDER BY id')).rows;
			expect(rows).toHaveLength(2);
			expect(rows).toContainEqual(failed[0]);
			const approved = rows.find(row => row.id === result.approvalRequest.id);
			expect(approved).toBeDefined();
			expect(serializeApprovalRequest(approved)).toEqual(result.approvalRequest);
			const inbox = (await f.right.pool.query('SELECT * FROM team_inbox_items')).rows;
			expect(inbox).toHaveLength(1);
			expect(inbox[0]).toMatchObject({ id: `seed-approval:${result.approvalRequest.id}`, team_id: 'team', project_id: 'project', state: 'waiting_for_approval', item_key: result.approvalRequest.id });
			expect(JSON.parse(inbox[0].metadata_json)).toEqual({ approvalId: result.approvalRequest.id, approvalRequestId: result.approvalRequest.id,
				approvalKind: 'seed_production_apply', seed: { name: 'execution', version: 1, environments: ['prod'], manifestHash: 'held-manifest', planSummary: plan.summary } });
			expect(input).toEqual(before);
			expect(await f.snapshot()).toEqual({ nodes: [], edges: [], revisions: [], assignments: [], reservations: [] });
		} finally { await f.close(); }
	});
	it('returns exact execution recipe command diagnostics for missing malformed and empty argv without changing supplied inputs', () => {
		const path = 'operationRecipes[0].steps[0].command';
		const missing = { severity: 'error', code: 'seed.recipe_command_missing_argv', message: 'Recipe command must include argv.', path: `${path}.argv` };
		for (const value of [{}, { argv: undefined }, { argv: null }, { argv: 1 }, { argv: 'node' }, { argv: {} }, { argv: [] }, { argv: [' ', ''] }]) {
			const before = structuredClone(value), diagnostics: SeedDiagnostic[] = [];
			expect(parseRecipeCommand(value, path, diagnostics)).toEqual({ argv: [] });
			expect(diagnostics).toEqual(value.argv !== undefined && !Array.isArray(value.argv)
				? [{ severity: 'error', code: 'seed.invalid_array', message: 'Expected argv to be an array.', path: `${path}.argv` }, missing] : [missing]);
			expect(value).toEqual(before);
		}
		const diagnostics: SeedDiagnostic[] = [], value = { argv: [' node ', '--check', 'tests/execution.ts'] };
		expect(parseRecipeCommand(value, path, diagnostics)).toEqual({ argv: ['node', '--check', 'tests/execution.ts'] });
		expect(parseRecipeCommand(undefined, path, diagnostics)).toBeUndefined();
		expect(diagnostics).toEqual([]);
		expect(value.argv).toEqual([' node ', '--check', 'tests/execution.ts']);
		expect(parseRecipeCommand(null, path, diagnostics)).toBeUndefined();
		expect(diagnostics).toEqual([{ severity: 'error', code: 'seed.invalid_object', message: 'Expected command to be an object.', path }]);
	});
	it('native seed file planning denies invalid execution command bytes without repairing inputs and admits only the explicit valid retry', async () => {
		const root = await mkdtemp(join(tmpdir(), 'api494-execution-recipe-'));
		try {
			await mkdir(join(root, 'seeds'));
			const path = join(root, 'seeds', 'execution.yaml');
			const manifest = (command: unknown) => stringify({ name: 'execution', version: 1, environments: ['local'], resources: {},
				operationRecipes: [{ id: 'execution', title: 'Configured execution', environments: ['local'], entrypoints: ['verify'],
					steps: [{ id: 'verify', title: 'Verify execution', channel: 'provider-runtime', operation: 'system.health', command }] }] });
			for (const command of [{}, { argv: null }, { argv: 1 }, { argv: 'node' }, { argv: {} }, { argv: [] }, { argv: [' ', ''] }]) {
				const bytes = manifest(command);
				await writeFile(path, bytes);
				const result = loadAndPlanCoreSeed({ projectRoot: root, seedName: 'execution', environments: 'local', mode: 'plan' });
				expect(result.ok).toBe(false);
				expect(result.plan).toBeNull();
				expect(result.diagnostics.filter(entry => entry.severity === 'error')).toEqual(command.argv !== undefined && !Array.isArray(command.argv)
					? [{ severity: 'error', code: 'seed.invalid_array', message: 'Expected argv to be an array.', path: 'operationRecipes[0].steps[0].command.argv' },
						{ severity: 'error', code: 'seed.recipe_command_missing_argv', message: 'Recipe command must include argv.', path: 'operationRecipes[0].steps[0].command.argv' }]
					: [{ severity: 'error', code: 'seed.recipe_command_missing_argv', message: 'Recipe command must include argv.', path: 'operationRecipes[0].steps[0].command.argv' }]);
				expect(await readFile(path, 'utf8')).toBe(bytes);
			}
			const bytes = manifest({ argv: ['node', '--check', 'tests/execution.ts'] });
			await writeFile(path, bytes);
			const result = loadAndPlanCoreSeed({ projectRoot: root, seedName: 'execution', environments: 'local', mode: 'plan' });
			expect(result.ok).toBe(true);
			expect(result.plan?.recipes[0]?.orderedSteps[0]?.command).toEqual({ argv: ['node', '--check', 'tests/execution.ts'] });
			expect(result.diagnostics.filter(entry => entry.severity === 'error')).toEqual([]);
			expect(await readFile(path, 'utf8')).toBe(bytes);
		} finally { await rm(root, { recursive: true, force: true }); }
		await expect(readFile(join(root, 'seeds', 'execution.yaml'))).rejects.toMatchObject({ code: 'ENOENT' });
	});
	it('binds the complete SDK-owned portable seed lifecycle', () => {
		const operations = createSeedOperations({ seeds: {} as any });
		expect(operations.map((operation) => operation.binding)).toEqual([
			CONTROL_PLANE_OPERATIONS.seeds.runs,
			CONTROL_PLANE_OPERATIONS.seeds.run,
			CONTROL_PLANE_OPERATIONS.seeds.validate,
			CONTROL_PLANE_OPERATIONS.seeds.plan,
			CONTROL_PLANE_OPERATIONS.seeds.apply,
			CONTROL_PLANE_OPERATIONS.seeds.show,
			CONTROL_PLANE_OPERATIONS.seeds.verify,
			CONTROL_PLANE_OPERATIONS.seeds.reconcile,
			CONTROL_PLANE_OPERATIONS.seeds.resolveResources,
		]);
	});

	it('validates an uploaded digest-bound bundle without filesystem access', async () => {
		const unsigned: any = { schemaVersion: 'treeseed.seed-bundle/v3', name: 'treeseed', version: 1,
			description: 'test', environments: ['local'], resources: { teams: [], memberships: [], projects: [], repositories: [] },
			runtime: { capacityProviders: [] } };
		const value = { ...unsigned, digest: await digestSeedBundle(unsigned) };
		const service = createSeedOperationService({} as any);
		await expect(service.validate({ id: 'user-1' }, { bundle: value })).resolves.toMatchObject({ ok: true, name: 'treeseed' });
		await expect(service.validate({ id: 'user-1' }, { bundle: { ...value, digest: `sha256:${'0'.repeat(64)}` } }))
			.resolves.toMatchObject({ ok: false, diagnostics: [expect.objectContaining({ code: 'seed_bundle_digest_mismatch' })] });
	});

	it('keeps run inspection authenticated and bounded', async () => {
		const service = createSeedOperationService({ async listSeedRuns(limit: number) { return [{ limit }]; } } as any, { repoRoot: '/tmp/unused' });
		await expect(service.runs({ id: 'user-1' }, { limit: 10_000 })).resolves.toEqual({ items: [{ limit: 100 }] });
		await expect(service.runs(undefined, {})).rejects.toMatchObject({ status: 401, code: 'authentication_required' });
	});

	it('turns a trusted local seed prerequisite into a bounded enrollment handoff', async () => {
		const providers = { connect: vi.fn().mockResolvedValue({ registrationCode: 'team-code', connectionState: 'registration_ready', expiresAfterUse: false }) };
		const plan = { seed: 'treeseed', version: 4, actions: [{ key: 'team:treeseed', existing: { id: 'team-1' } }], runtime: { capacityProviders: [{
			key: 'capacity-provider:treeseed/local', team: 'team:treeseed', approval: 'trusted-local-owner', requiredLanePurposes: ['communication', 'platform', 'workday'], projects: [], environments: ['local'],
		}] } };
		const closure = await reconcileSeedProviderPrerequisites({ first: vi.fn().mockResolvedValue(null) } as any, { providers }, plan, true, { id: 'owner-1' });
		expect(providers.connect).toHaveBeenCalledWith({ id: 'owner-1' }, 'team-1', 'seed:treeseed:4:capacity-provider:treeseed/local:enroll');
		expect(closure).toEqual({ status: 'waiting_provider', receipts: [expect.objectContaining({
			key: 'capacity-provider:treeseed/local', status: 'enrollment_required', teamId: 'team-1', connectionId: 'local-team-1', approval: 'trusted-local-owner', registrationCode: 'team-code', expiresAfterUse: false,
		})] });
	});

	it('verifies authorized provider readiness without a retired allocation set', async () => {
		const store = {
			ensureInitialized: vi.fn(), all: vi.fn().mockResolvedValue([{ id: 'lane-1', purpose: 'communication', execution_provider_id: 'execution-1' }]),
			first: vi.fn(async (query: string) => {
				if (query.includes('capacity_provider_team_memberships membership')) return { id: 'membership-1', capacity_provider_id: 'provider-1' };
				if (query.includes('capacity_provider_availability_sessions')) return { id: 'session-1' };
				if (query.includes('capacity_grants')) return { id: 'grant-1', status: 'active' };
				if (query.includes('capacity_allocation_sets')) throw new Error('Retired allocation lookup');
				return null;
			}), run: vi.fn(),
		};
		const plan = { seed: 'treeseed', version: 4, actions: [
			{ key: 'team:treeseed', existing: { id: 'team-1' } },
			{ key: 'project:treeseed/sdk', existing: { id: 'project-1' } },
		], runtime: { capacityProviders: [{ key: 'capacity-provider:treeseed/local', team: 'team:treeseed', approval: 'trusted-local-owner',
			requiredLanePurposes: ['communication'], projects: ['project:treeseed/sdk'], environments: ['local'] }] } };
		await expect(reconcileSeedProviderPrerequisites(store as any, {}, plan, false)).resolves.toEqual({ status: 'verified', receipts: [expect.objectContaining({
			status: 'verified', projects: [{ projectKey: 'project:treeseed/sdk', environment: 'local', status: 'active', grantId: 'grant-1' }],
		})] });
	});

	it('reconciles seeded grants with the execution provider capabilities required by agent work', async () => {
		const store = {
			ensureInitialized: vi.fn(),
			all: vi.fn().mockResolvedValue([
				{ id: 'communication', purpose: 'communication', execution_provider_id: 'execution-1', execution_provider_capabilities_json: JSON.stringify(['treeseed.coordination.conversation']) },
				{ id: 'workday', purpose: 'workday', execution_provider_id: 'execution-1', execution_provider_capabilities_json: JSON.stringify(['treeseed.engineering.code-change']) },
			]),
			first: vi.fn(async (query: string) => {
				if (query.includes('capacity_provider_team_memberships membership')) return { id: 'membership-1', capacity_provider_id: 'provider-1' };
				if (query.includes('capacity_provider_availability_sessions')) return { id: 'session-1' };
				if (query.includes('capacity_grants')) return { id: 'grant-1', status: 'active' };
				if (query.includes('capacity_allocation_sets')) throw new Error('Retired allocation lookup');
				return null;
			}),
			run: vi.fn(),
		};
		const plan = { seed: 'treeseed', version: 4, actions: [
			{ key: 'team:treeseed', existing: { id: 'team-1' } },
			{ key: 'project:treeseed/sdk', existing: { id: 'project-1' } },
		], runtime: { capacityProviders: [{ key: 'capacity-provider:treeseed/local', team: 'team:treeseed', approval: 'trusted-local-owner',
			requiredLanePurposes: ['communication', 'workday'], projects: ['project:treeseed/sdk'], environments: ['local'], allowedModes: ['planning', 'acting'] }] } };

		await reconcileSeedProviderPrerequisites(store as any, {}, plan, true, { id: 'owner-1' });

		expect(store.all).toHaveBeenCalledWith(expect.stringContaining('execution_provider.capacity_provider_id = lane.capacity_provider_id'), ['provider-1']);
		expect(store.run).toHaveBeenCalledWith(expect.stringContaining('allowed_modes_json = ?'), [
			JSON.stringify(['execution-1']), JSON.stringify(['communication', 'workday']),
			JSON.stringify(['treeseed.coordination.conversation', 'treeseed.engineering.code-change']), JSON.stringify(['planning', 'acting']),
			expect.any(String), 'grant-1', 'membership-1',
		]);
	});

	it('requires platform seed authority for resource resolution', async () => {
		const service = createSeedOperationService({} as any, { repoRoot: '/tmp/unused' });
		await expect(service.resolveResources({ id: 'user-1', roles: [], permissions: [] }, { keys: ['team:treeseed'] }))
			.rejects.toMatchObject({ status: 403, code: 'seed_global_access_denied' });
	});

	it('makes the authenticated seed user an owner of every locally seeded team', async () => {
		const store = {
			resolvePrincipalTeamContext: vi.fn().mockResolvedValue(null),
			upsertTeamMember: vi.fn(async (teamId: string, userId: string, role: string) => ({ teamId, userId, role })),
		};
		const plan = {
			environments: ['local'],
			actions: [
				{ kind: 'team', key: 'team:treeseed', action: 'create', environments: ['local'] },
				{ kind: 'team', key: 'team:custom', action: 'create', environments: ['local'] },
			],
		};
		const memberships = await ensureLocalSeedTeamMemberships({
			store,
			plan,
			ids: { teams: new Map([['team:treeseed', 'team-1'], ['team:custom', 'team-2']]) },
			actor: { principal: { id: 'user-1', roles: ['member'], metadata: { email: 'user@example.test' } } },
			env: {},
		});

		expect(store.upsertTeamMember).toHaveBeenCalledTimes(2);
		expect(store.upsertTeamMember).toHaveBeenNthCalledWith(1, 'team-1', 'user-1', 'team_owner');
		expect(store.upsertTeamMember).toHaveBeenNthCalledWith(2, 'team-2', 'user-1', 'team_owner');
		expect(memberships).toEqual([
			expect.objectContaining({ teamId: 'team-1', userId: 'user-1', role: 'team_owner' }),
			expect.objectContaining({ teamId: 'team-2', userId: 'user-1', role: 'team_owner' }),
		]);
	});

	it('grants local team ownership before applying dependent project actions', async () => {
		const events: string[] = [];
		let ownsTeam = false;
		const ids = { teams: new Map(), projects: new Map(), projectTeams: new Map() };
		const plan = {
			environments: ['local'],
			actions: [
				{ kind: 'team', key: 'team:treeseed', action: 'create', environments: ['local'], payload: {} },
				{ kind: 'project', key: 'project:treeseed/platform', action: 'create', environments: ['local'], payload: { teamKey: 'team:treeseed' } },
			],
		};

		const result = await applyPlannedSeedActions({
			plan, store: {}, ids, manifestHash: 'sha256:test', appliedAt: '2026-09-01T00:00:00.000Z',
			localOnly: true, actor: { principal: { id: 'user-1', roles: ['member'] } }, dependencyState: {},
		}, {
			async applyAction({ action }: any) {
				events.push(`apply:${action.kind}`);
				if (action.kind === 'team') ids.teams.set(action.key, 'team-1');
				if (action.kind === 'project') {
					if (!ownsTeam) throw Object.assign(new Error('Permission denied.'), { code: 'permission_denied' });
					ids.projects.set(action.key, 'project-1');
				}
			},
			async ensureLocalSeedTeamMemberships() {
				events.push('grant:team_owner');
				ownsTeam = true;
				return [{ teamId: 'team-1', userId: 'user-1', role: 'team_owner' }];
			},
			async ensureProjectSeedDependencies({ action }: any) {
				events.push(`dependencies:${action.kind}`);
				return [];
			},
		});

		expect(events).toEqual([
			'apply:team', 'grant:team_owner', 'dependencies:team',
			'apply:project', 'dependencies:project',
		]);
		expect(result.localTeamMemberships).toEqual([
			expect.objectContaining({ teamId: 'team-1', userId: 'user-1', role: 'team_owner' }),
		]);
	});

	it('rejects removed resource families instead of retaining dormant schemas', () => {
		const result = validateSeedSource(`name: clean\nversion: 1\nenvironments: [local]\nresources:\n  teams: []\n  teamMemberships: []\n  projects: []\n  hubRepositories: []\n  supportRepositories: []\n  products: []\n`);
		expect(result).toMatchObject({ ok: false, diagnostics: [expect.objectContaining({
			code: 'seed.unsupported_resource_kind', path: 'resources.products',
		})] });
	});

	it('does not treat an action-only resource key as persisted-state drift', () => {
		expect(actionIsUnchanged({ payload: {
			key: 'team:treeseed', slug: 'treeseed',
			metadata: { seed: { name: 'treeseed', resourceKey: 'team:treeseed', version: 2 } },
		} }, {
			slug: 'treeseed',
			metadata: { seed: { name: 'treeseed', resourceKey: 'team:treeseed', version: 2,
				lastAppliedAt: '2026-08-23T00:00:00.000Z', manifestHash: 'sha256:test' } },
		})).toBe(true);
	});
});
