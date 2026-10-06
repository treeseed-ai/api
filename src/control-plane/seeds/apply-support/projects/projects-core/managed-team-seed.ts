import { mergeSeedMetadata, projectSeedMetadata } from '../../index.js';

export const isTeamLibrarySeed = (action: any) => action.kind === 'project' && action.payload.slug === 'team';

/** The seed owns the repository identity; runtime defaults cannot override it. */
export async function applyTeamLibrarySeed({ action, store, ids, manifestHash, appliedAt }: any) {
	const { payload } = action;
	if (payload.kind !== 'content' || payload.repository || !payload.library)
		throw new Error('The reserved team project must declare a content-only library repository.');
	const teamId = ids.teams.get(payload.teamKey);
	if (!teamId) throw new Error(`Missing team for ${action.key}.`);
	const project = await store.ensureManagedTeamLibraryProject(teamId);
	const current = project.metadata ?? {};
	const desired = payload.library;
	const binding = await store.getProjectTreeDxLibrary(project.id);
	const remote = await store.first('SELECT owner,name FROM project_remote_repository_bindings WHERE project_id = ? LIMIT 1', [project.id]);
	if ((remote && (remote.owner !== desired.owner || remote.name !== desired.name))
		|| (binding && (current.library?.owner !== desired.owner || current.library?.repositoryName !== desired.name)))
		throw new Error(`Seed Team Library ${desired.owner}/${desired.name} conflicts with an established binding; explicit repository relocation is required.`);
	const updated = await store.updateProject(project.id, {
		name: payload.name, description: payload.description,
		metadata: {
			...current,
			metadata: mergeSeedMetadata(projectSeedMetadata(current), payload.metadata, action, manifestHash, appliedAt),
			kind: 'system-team-library', systemManaged: true, libraryOnly: true,
			library: { ...current.library, ...desired, owner: desired.owner, repositoryName: desired.name },
		},
	});
	ids.projects.set(action.key, updated.id);
	ids.projectTeams.set(action.key, teamId);
	return updated;
}
