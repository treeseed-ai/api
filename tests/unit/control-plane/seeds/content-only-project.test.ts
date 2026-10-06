import { describe, expect, it, vi } from 'vitest';
import { digestSeedBundle, type SeedBundleV3 } from '@treeseed/sdk/operator-contracts';
import { applyAction } from '../../../../src/control-plane/seeds/apply-support/support/action-dispatch.ts';
import { planPortableSeedBundle } from '../../../../src/control-plane/seeds/planning/plan-portable-seed-bundle.ts';
import { ControlPlaneStore } from '../../../../src/api/persistence/store.ts';
import { postgresGraph } from '../capacity/execution/graph/architecture/living/living-postgres-fixture.ts';
import type { SeedPlanAction } from '../../../../src/control-plane/seeds/contracts/types.ts';

describe('library-only seed projects', () => {
	it('execution seed actions deny missing team or project read-back without publishing derived identity maps', async () => {
		const metadata = { seed: { name: 'execution', version: 1, resourceKey: 'resource' } };
		const failures: Array<{ error: unknown; message: string }> = [];
		for (const kind of ['team', 'project'] as const) for (const existing of [false, true]) {
			const store = new ControlPlaneStore({}, { prepare() { throw new Error('Unexpected unit SQL'); } });
			const action: SeedPlanAction = kind === 'team'
				? { kind, key: 'team:execution', label: 'Execution', environments: ['local'], action: existing ? 'update' : 'create',
					payload: { slug: 'execution', name: 'execution', displayName: 'Execution', metadata }, existing: existing ? { id: 'old-team' } : null }
				: { kind, key: 'project:execution/agent', label: 'Agent', environments: ['local'], action: existing ? 'update' : 'create',
					payload: { teamKey: 'team:execution', slug: 'agent', name: 'Agent', metadata }, existing: existing ? { id: 'old-project' } : null };
			const before = structuredClone(action), ids = { teams: new Map([['team:execution', 'held-team']]), projects: new Map<string, string>(), projectTeams: new Map<string, string | undefined>() }, held = structuredClone(ids);
			vi.spyOn(store, 'createTeam').mockResolvedValue(null);
			vi.spyOn(store, 'updateTeamSettings').mockResolvedValueOnce(null).mockResolvedValueOnce({ ok: true, team: null });
			vi.spyOn(store, 'getTeam').mockResolvedValue(null);
			vi.spyOn(store, 'createProject').mockResolvedValue(null);
			vi.spyOn(store, 'updateProject').mockResolvedValue(null);
			const input = { action, store, ids, manifestHash: 'held-manifest', appliedAt: '2026-10-06T00:00:00.000Z', plan: { seed: 'execution', actions: [action] } };
			for (let attempt = 0; attempt < (kind === 'team' && existing ? 2 : 1); attempt++) {
				let error: unknown; try { await applyAction(input); } catch (cause) { error = cause; }
				failures.push({ error, message: `Seed ${kind} could not be read back for ${action.key}.` });
			}
			expect(action).toEqual(before);
			expect(ids).toEqual(held);
		}
		expect(failures).toHaveLength(5);
		for (const failure of failures) expect(failure.error).toMatchObject({ message: failure.message });
	});
	it('native execution seed updates retain moved PostgreSQL rows and require independently supplied current authority for a fresh success', async () => {
		const failures: Array<{ error: unknown; message: string }> = [];
		for (const kind of ['team', 'project'] as const) {
			const f = await postgresGraph();
			try {
				const store = new ControlPlaneStore({ TREESEED_ENVIRONMENT: 'test' }, f.left); store.initializationPromise = Promise.resolve();
				await f.left.pool.query("INSERT INTO teams (id,slug,name,created_at,updated_at) VALUES ('retry-team','retry-team','Retry team',$1,$1)", ['2026-10-06T00:00:00.000Z']);
				if (kind === 'project') await f.left.pool.query("INSERT INTO projects (id,team_id,slug,name,created_at,updated_at) VALUES ('project','team','agent','Agent',$1,$1),('retry-project','team','retry-agent','Retry agent',$1,$1)", ['2026-10-06T00:00:00.000Z']);
				const action: SeedPlanAction = kind === 'team'
					? { kind, key: 'team:execution', label: 'Execution', environments: ['local'], action: 'update', existing: { id: 'team' },
						payload: { slug: 'graph-team', name: 'graph-team', displayName: 'Execution', metadata: { seed: { name: 'execution', version: 1, resourceKey: 'team:execution' } } } }
					: { kind, key: 'project:execution/agent', label: 'Agent', environments: ['local'], action: 'update', existing: { id: 'project' },
						payload: { teamKey: 'team:execution', slug: 'agent', name: 'Agent', metadata: { seed: { name: 'execution', version: 1, resourceKey: 'project:execution/agent' } } } };
				const before = structuredClone(action), ids = { teams: new Map([['team:execution', 'team']]), projects: new Map<string, string>(), projectTeams: new Map<string, string | undefined>() }, held = structuredClone(ids);
				const table = kind === 'team' ? 'teams' : 'projects';
				await f.left.pool.query(`CREATE FUNCTION moved_seed_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.id := 'interrupted-' || NEW.id; RETURN NEW; END $$;
					CREATE TRIGGER moved_seed_update BEFORE UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION moved_seed_update()`);
				const input = { action, store, ids, manifestHash: 'held-manifest', appliedAt: '2026-10-06T00:00:00.000Z', plan: { seed: 'execution', actions: [action] } };
				let error: unknown; try { await applyAction(input); } catch (cause) { error = cause; }
				failures.push({ error, message: `Seed ${kind} could not be read back for ${action.key}.` });
				const failed = (await f.right.pool.query(`SELECT * FROM ${table} WHERE id = $1`, [`interrupted-${action.existing?.id}`])).rows;
				expect(failed).toHaveLength(1); expect(action).toEqual(before); expect(ids).toEqual(held);
				await f.left.pool.query(`DROP TRIGGER moved_seed_update ON ${table}; DROP FUNCTION moved_seed_update()`);
				// The failed request stays failed. Only an independently read, different
				// current resource is eligible for this explicit replacement attempt.
				const currentId = kind === 'team' ? 'retry-team' : 'retry-project';
				const current = kind === 'team' ? await store.getTeam(currentId) : await store.getProject(currentId);
				if (!current) throw new Error('Native replacement authority missing');
				const retry: SeedPlanAction = { ...action, payload: { ...action.payload, slug: current.slug, name: current.name }, existing: { id: current.id } };
				const result = await applyAction({ ...input, action: retry, plan: { seed: 'execution', actions: [retry] } });
				expect(result?.id).toBe(currentId);
				expect(kind === 'team' ? ids.teams.get(action.key) : ids.projects.get(action.key)).toBe(currentId);
				expect((await f.right.pool.query(`SELECT * FROM ${table} WHERE id = $1`, [failed[0].id])).rows).toEqual(failed);
				expect(await f.snapshot()).toEqual({ nodes: [], edges: [], revisions: [], assignments: [], reservations: [] });
				expect(action).toEqual(before);
			} finally { await f.close(); }
		}
		expect(failures).toHaveLength(2);
		for (const failure of failures) expect(failure.error).toMatchObject({ message: failure.message });
	});
	it('plans the project with an explicit Git library and no primary repository', async () => {
		const unsigned: Omit<SeedBundleV3, 'digest'> = {
			schemaVersion: 'treeseed.seed-bundle/v3',
			name: 'knowledge',
			version: 1,
			description: 'Content-only project fixture.',
			environments: ['local'],
			resources: {
				teams: [{ key: 'team:fixture', slug: 'fixture', name: 'fixture', displayName: 'Fixture' }],
				memberships: [],
				projects: [{ key: 'project:fixture/knowledge', team: 'team:fixture', slug: 'knowledge', name: 'Knowledge', description: 'Library knowledge only.', kind: 'content', libraryRepository: 'repository:fixture/knowledge-library' }],
				repositories: [{ key: 'repository:fixture/knowledge-library', project: 'project:fixture/knowledge', role: 'library', provider: 'github', owner: 'fixture', name: 'knowledge-library', gitUrl: 'https://github.com/fixture/knowledge-library.git', defaultBranch: 'main', repositoryPolicy: { visibility: 'public', lifecycle: 'create-or-adopt', deletionPolicy: 'retain', defaultBranch: 'main', stagingBranch: 'staging', issues: true, actions: true, workflows: [] } }],
			},
			runtime: { capacityProviders: [] },
		};
		const bundle = { ...unsigned, digest: await digestSeedBundle(unsigned) };
		const result = await planPortableSeedBundle({ bundle, seedName: 'knowledge', mode: 'plan' });
		const project = result.plan?.actions.find((action) => action.kind === 'project');
		expect(result.ok).toBe(true);
		expect(project?.payload.repository).toBeNull();
		expect(project?.payload.library).toMatchObject({ role: 'library', name: 'knowledge-library' });
		expect(result.plan?.actions.some((action) => action.kind === 'hubRepository')).toBe(true);
	});

	it('does not persist an empty legacy architecture object', async () => {
		const updateProject = vi.fn(async (_projectId, input) => ({ id: 'project-1', ...input }));
		await applyAction({
			action: {
				kind: 'project', key: 'project:fixture/knowledge', action: 'update', existing: { id: 'project-1', metadata: {} },
				payload: { teamKey: 'team:fixture', slug: 'knowledge', name: 'Knowledge', description: 'Virtual knowledge only.',
					kind: 'content', repository: null, library: { role: 'library' }, architecture: {}, metadata: {} },
			},
			store: { updateProject },
			ids: { teams: new Map([['team:fixture', 'team-1']]), projects: new Map(), projectTeams: new Map() },
			manifestHash: `sha256:${'0'.repeat(64)}`, appliedAt: '2026-08-23T00:00:00.000Z', plan: { seed: 'fixture' },
		} as never);
		expect(updateProject).toHaveBeenCalledWith('project-1', expect.objectContaining({
			metadata: expect.not.objectContaining({ architecture: expect.anything() }),
		}));
	});
});
