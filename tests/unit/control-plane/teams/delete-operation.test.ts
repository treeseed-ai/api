import { describe, expect, it, vi } from 'vitest';
import { createTeamDeleteOperation } from '../../../../src/api/control-plane/catalog/team-operations.ts';

const context = { principal: { id: 'user-1', metadata: { sessionId: 'session-1' } }, ifMatch: '4', interface: 'rest' as const, requestId: 'request-1' };

function dependencies(prepared: Record<string, unknown>) {
	const first = vi.fn(async (query: string) => query.includes('auth_reauthentication_grants')
		? { id: 'grant-1', expires_at: '2099-01-01T00:00:00Z' } : null);
	const batch = vi.fn(async () => undefined);
	const prepareTeamDeletion = vi.fn(async () => prepared);
	const deleteManagedTeamLibraryResources = vi.fn(async () => ({ schemaVersion: 'treeseed.team-library-deletion-receipt/v1' }));
	return { first, batch, prepareTeamDeletion, value: { store: {
		async getTeam() { return { id: 'team-1', name: 'tree-team', status: 'archived', lifecycleVersion: 4 }; },
		async getProjectByTeamAndSlug() { return { id: 'team-library-project', metadata: { kind: 'system-team-library', systemManaged: true } }; },
		async getProjectTreeDxLibrary() { return { repositoryId: 'repo-team-library' }; },
		async principalCanAccessTeam() { return true; },
		async resolvePrincipalTeamContext() { return { roles: ['team_owner'] }; },
		first, run: vi.fn(async () => undefined), all: vi.fn(async () => []), batch, prepareTeamDeletion,
		listTeamMembers: vi.fn(async () => []), recordAuditEvent: vi.fn(async () => undefined),
	}, treeDxProxy: { invoke: vi.fn(async () => ({ retired: true })) }, deleteManagedTeamLibraryResources } as any };
}

describe('team deletion catalog operation', () => {
	it('checks confirmation and blockers before consuming reauthentication', async () => {
		const fixture = dependencies({ ok: false, code: 'confirmation', message: 'Type DELETE tree-team to confirm.' });
		await expect(createTeamDeleteOperation(fixture.value).handler({ path: { teamId: 'team-1' }, query: {}, body: {
			confirmation: 'wrong', reauthenticationGrantId: 'grant-1',
		} }, context)).rejects.toMatchObject({ status: 400, code: 'confirmation' });
		expect(fixture.first).not.toHaveBeenCalled();
		expect(fixture.batch).not.toHaveBeenCalled();
	});

	it('deletes only after current lifecycle and one-use reauthentication checks pass', async () => {
		const fixture = dependencies({ ok: true, team: { id: 'team-1' } });
		await expect(createTeamDeleteOperation(fixture.value).handler({ path: { teamId: 'team-1' }, query: {}, body: {
			confirmation: 'DELETE tree-team', reauthenticationGrantId: 'grant-1',
		} }, context)).resolves.toEqual(expect.objectContaining({ ok: true, deleted: true, teamId: 'team-1',
			receipt: expect.objectContaining({ schemaVersion: 'treeseed.team-deletion-receipt/v1' }) }));
		expect(fixture.prepareTeamDeletion).toHaveBeenCalledTimes(2);
		expect(fixture.batch).toHaveBeenCalledOnce();
	});
});
