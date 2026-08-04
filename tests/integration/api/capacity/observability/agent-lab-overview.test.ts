import { authorizeApp, createTeamAndProject, createTestApp, createTestPostgresDatabase, createTestStore, describe, expect, it, json } from '../../../../support/api-harness.ts';
import { CapacityAllocationService } from '../../../../../src/api/capacity/services/capacity/allocations/allocation-service.ts';

describe('Agent Lab read projections', () => {
	it('authorizes team access and serves coherent conditional snapshots', async () => {
		const db = createTestPostgresDatabase(); const store = createTestStore(db); const app = createTestApp({ db, store });
		const token = await authorizeApp(app, { principalId: 'agent-lab-user', displayName: 'Agent Lab User' });
		const { team } = await createTeamAndProject(app, token, { slug: 'agent-lab-team', name: 'Agent Lab Team', description: 'Monitoring projection.' });
		const headers = { authorization: `Bearer ${token}` };
		await store.run('UPDATE teams SET metadata_json = ? WHERE id = ?', [JSON.stringify({ preserved: { value: true }, agentLab: { metricTargets: { agents: 2 } } }), team.id]);
		const first = await app.request(`/v1/teams/${team.id}/agent-lab/overview`, { headers });
		expect(first.status).toBe(200); const etag = first.headers.get('etag'); expect(etag).toBeTruthy();
		const payload = await json(first); expect(payload.payload).toMatchObject({ team: { id: team.id, name: team.name }, activeWorkdays: 0, activeProviders: 0, metricTargets: { agents: 2 } });
		expect(payload.payload.metrics.map((metric: { key: string }) => metric.key)).toEqual(['agents', 'workdays', 'systemEvents', 'assignments', 'executions', 'artifacts', 'passed', 'failed', 'running']);
		const unchanged = await app.request(`/v1/teams/${team.id}/agent-lab/overview`, { headers: { ...headers, 'if-none-match': etag! } });
		expect(unchanged.status).toBe(304); expect(await unchanged.text()).toBe('');
		const forbidden = await app.request('/v1/teams/not-a-team/agent-lab/overview', { headers });
		expect([403, 404]).toContain(forbidden.status);
		const context = await app.request(`/v1/teams/${team.id}/agent-lab/workday-context`, { headers });
		expect(context.status).toBe(200); expect((await json(context)).payload).toMatchObject({ selectedWorkdayId: null, latestWorkdayId: null, workdays: [] });
		const invalid = await app.request(`/v1/teams/${team.id}/agent-lab/targets`, { method: 'PATCH', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ targets: { agents: -1 }, expectedRevision: payload.payload.targetRevision }) });
		expect(invalid.status).toBe(400);
		const updated = await app.request(`/v1/teams/${team.id}/agent-lab/targets`, { method: 'PATCH', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ targets: { failed: 0 }, expectedRevision: payload.payload.targetRevision }) });
		expect(updated.status).toBe(200); expect((await json(updated)).payload.targets).toEqual({ agents: 2, failed: 0 });
		const stale = await app.request(`/v1/teams/${team.id}/agent-lab/targets`, { method: 'PATCH', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ targets: { running: 3 }, expectedRevision: 'stale-revision' }) });
		expect(stale.status).toBe(409);
		const persisted = await store.first('SELECT metadata_json FROM teams WHERE id = ? LIMIT 1', [team.id]);
		expect(JSON.parse(String(persisted?.metadata_json))).toMatchObject({ preserved: { value: true }, agentLab: { metricTargets: { agents: 2, failed: 0 } } });
	});

	it('updates allocation scopes independently while preserving hierarchy guardrails', async () => {
		const db = createTestPostgresDatabase(); const store = createTestStore(db); const app = createTestApp({ db, store });
		const token = await authorizeApp(app, { principalId: 'allocation-owner', displayName: 'Allocation Owner' }); const { team, project } = await createTeamAndProject(app, token, { slug: 'allocation-team', name: 'Allocation Team', description: 'Allocation projection.' }); const now = new Date().toISOString();
		await store.run(`INSERT INTO project_agent_classes (id, team_id, project_id, slug, name, status, allowed_modes_json, required_capabilities_json, kernel_profile_json, kernel_policy_json, handler_refs_json, output_contracts_json, metadata_json, created_at, updated_at) VALUES ('class-a', ?, ?, 'class-a', 'Class A', 'active', '["planning"]', '[]', '{}', '{}', '{}', '{}', '{}', ?, ?), ('class-b', ?, ?, 'class-b', 'Class B', 'active', '["planning"]', '[]', '{}', '{}', '{}', '{}', '{}', ?, ?)`, [team.id, project.id, now, now, team.id, project.id, now, now]);
		const allocations = new CapacityAllocationService(store); const projectSlice = `project:${project.id}`;
		await allocations.create(team.id, { id: 'allocation-a', slices: [
			{ id: projectSlice, scope: 'project', targetId: project.id, policy: { minPercent: 0, targetPercent: 100, maxPercent: 100, hardCapPercent: 100 } },
			{ id: 'slice-a', scope: 'agent-class', targetId: 'class-a', parentSliceId: projectSlice, policy: { minPercent: 10, targetPercent: 60, maxPercent: 70, hardCapPercent: 80 } },
			{ id: 'slice-b', scope: 'agent-class', targetId: 'class-b', parentSliceId: projectSlice, policy: { minPercent: 0, targetPercent: 40, maxPercent: 100, hardCapPercent: 100 } },
			{ id: 'mode-a', scope: 'mode', targetId: 'planning', parentSliceId: 'slice-a', policy: { minPercent: 0, targetPercent: 100, maxPercent: 100, hardCapPercent: 100 } },
		] }, 'allocation-owner', 'create-allocation-a'); await allocations.activate(team.id, 'allocation-a', 'activate-allocation-a');
		const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
		const portfolio = await app.request(`/v1/teams/${team.id}/agent-lab/allocation`, { method: 'POST', headers, body: JSON.stringify({ scope: 'portfolio', slices: [{ id: project.id, percentage: 100 }], expectedActiveAllocationSetId: 'allocation-a', requestId: 'portfolio-update' }) }); expect(portfolio.status).toBe(200); const portfolioBody = await json(portfolio);
		let active = await allocations.getActive(team.id); expect(active?.slices).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'slice-a' }), expect.objectContaining({ id: 'mode-a' })]));
		const classes = await app.request(`/v1/teams/${team.id}/agent-lab/allocation`, { method: 'POST', headers, body: JSON.stringify({ scope: 'agent-class', projectId: project.id, slices: [{ id: 'class-a', percentage: 65 }, { id: 'class-b', percentage: 35 }], expectedActiveAllocationSetId: portfolioBody.payload.activeAllocationSetId, requestId: 'class-update' }) }); expect(classes.status).toBe(200);
		active = await allocations.getActive(team.id); const classA = active?.slices.find((slice) => slice.targetId === 'class-a'); expect(classA?.policy).toEqual({ minPercent: 10, targetPercent: 65, maxPercent: 70, hardCapPercent: 80 }); expect(active?.slices.some((slice) => slice.id === 'mode-a')).toBe(true);
	});
});
