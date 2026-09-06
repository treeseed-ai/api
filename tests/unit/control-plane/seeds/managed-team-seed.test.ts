import { describe, expect, it, vi } from 'vitest';
import { applyTeamLibrarySeed } from '../../../../src/control-plane/seeds/apply-support/projects/projects-core/managed-team-seed.ts';

function fixture() {
	const project = { id: 'existing-team-project', metadata: { kind: 'system-team-library', systemManaged: true, library: { repositoryName: 'old-unbound-name', status: 'provisioning' } } };
	const store = {
		ensureManagedTeamLibraryProject: vi.fn(async () => project),
		getProjectTreeDxLibrary: vi.fn(async (): Promise<any> => null),
		first: vi.fn(async (): Promise<any> => null),
		updateProject: vi.fn(async (id, input) => ({ id, ...input })),
	};
	return { store, action: { kind: 'project', key: 'project:example/team', payload: {
		teamKey: 'team:example', slug: 'team', kind: 'content', name: 'Team Library', description: 'Shared knowledge', metadata: {},
		library: { owner: 'example', name: 'team-library', role: 'library', gitUrl: 'https://github.com/example/team-library.git', repositoryPolicy: { lifecycle: 'adopt' } },
	} }, ids: { teams: new Map([['team:example', 'team-id']]), projects: new Map(), projectTeams: new Map() }, manifestHash: 'sha256:fixture', appliedAt: '2026-09-05' };
}

describe('seed Team Library identity', () => {
	it('corrects an unbound provisioning identity without replacing the project', async () => {
		const input = fixture(); const result = await applyTeamLibrarySeed(input);
		expect(result.id).toBe('existing-team-project');
		expect(result.metadata).toMatchObject({ kind: 'system-team-library', systemManaged: true, libraryOnly: true,
			library: { owner: 'example', repositoryName: 'team-library', repositoryPolicy: { lifecycle: 'adopt' } } });
		expect(input.ids.projects.get(input.action.key)).toBe(result.id);
	});
	it('rejects repository substitution when remote authority is already bound', async () => {
		const input = fixture(); input.store.first.mockResolvedValue({ owner: 'example', name: 'different-library' });
		await expect(applyTeamLibrarySeed(input)).rejects.toThrow('established binding');
		expect(input.store.updateProject).not.toHaveBeenCalled();
	});
	it('rejects repository substitution when TreeDX is already bound', async () => {
		const input = fixture(); input.store.getProjectTreeDxLibrary.mockResolvedValue({ id: 'library' });
		await expect(applyTeamLibrarySeed(input)).rejects.toThrow('established binding');
		expect(input.store.updateProject).not.toHaveBeenCalled();
	});
	it('rejects a software project using the reserved slug', async () => {
		const input = fixture(); input.action.payload.kind = 'package';
		await expect(applyTeamLibrarySeed(input)).rejects.toThrow('content-only');
		expect(input.store.ensureManagedTeamLibraryProject).not.toHaveBeenCalled();
	});
});
