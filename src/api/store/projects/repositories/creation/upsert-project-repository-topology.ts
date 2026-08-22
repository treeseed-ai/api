import { normalizeProjectRepositoryTopology } from '../../../../repositories/project-topology.ts';
import type { ControlPlaneStore } from '../../../../persistence/store.ts';

export async function upsertProjectRepositoryTopologyMethod(this: ControlPlaneStore, projectId: string, input: unknown) {
	await this.ensureInitialized();
	const [project, library] = await Promise.all([this.getProject(projectId), this.getProjectTreeDxLibrary(projectId)]);
	if (!project || !library) return null;
	const topology = normalizeProjectRepositoryTopology(input);
	if (topology.contentRepository.treeDx.instanceId !== library.instanceId
		|| topology.contentRepository.treeDx.repositoryId !== library.repositoryId) {
		throw Object.assign(new Error('Repository topology cannot move a project to a different TreeDX repository.'), { code: 'treedx_repository_mismatch' });
	}
	const remote = topology.contentRepository.remote;
	if (remote) {
		const authority = await this.first(
			`SELECT a.id FROM provider_credential_authorities a
			 JOIN team_service_connections c ON c.id = a.connection_id AND c.team_id = ?
			 JOIN team_service_capability_bindings b ON b.id = ? AND b.connection_id = c.id
			 WHERE a.id = ? AND a.connection_id = ? AND a.status IN ('ready', 'interactive-only')
			 AND b.capability_type = 'repository-hosting' AND b.status = 'configured'`,
			[project.teamId, remote.capabilityBindingId, remote.authorityId, remote.serviceConnectionId],
		);
		if (!authority) throw Object.assign(new Error('The repository service binding and credential authority are unavailable.'), { code: 'repository_authority_unavailable' });
		const existing: any = await this.first(`SELECT version FROM project_remote_repository_bindings WHERE project_id = ?`, [projectId]);
		if (existing && Number(existing.version) !== remote.version) {
			throw Object.assign(new Error('The remote repository binding changed after it was loaded.'), { code: 'repository_binding_conflict' });
		}
		const now = new Date().toISOString();
		await this.run(
			`INSERT INTO project_remote_repository_bindings (
			 id, project_id, team_id, service_connection_id, capability_binding_id, provider_id, provider_repository_id,
			 owner, name, clone_url, default_ref, publication_ref, authority_id, expected_head, observed_head,
			 grant_status, drift, version, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
			ON CONFLICT(project_id) DO UPDATE SET service_connection_id = excluded.service_connection_id,
			 capability_binding_id = excluded.capability_binding_id, provider_id = excluded.provider_id,
			 provider_repository_id = excluded.provider_repository_id, owner = excluded.owner, name = excluded.name,
			 clone_url = excluded.clone_url, default_ref = excluded.default_ref, publication_ref = excluded.publication_ref,
			 authority_id = excluded.authority_id, expected_head = excluded.expected_head, observed_head = excluded.observed_head,
			 grant_status = excluded.grant_status, drift = excluded.drift, version = project_remote_repository_bindings.version + 1,
			 updated_at = excluded.updated_at`,
			[remote.bindingId, projectId, project.teamId, remote.serviceConnectionId, remote.capabilityBindingId,
				remote.providerId, remote.providerRepositoryId, remote.owner, remote.name, remote.cloneUrl, remote.defaultRef,
				remote.publicationRef, remote.authorityId, remote.expectedHead, remote.observedHead, remote.grantStatus,
				remote.drift, now, now],
		);
	}
	await this.run(`UPDATE treedx_project_libraries SET content_path = ?, content_repository_url = ?,
		content_repository_default_branch = ?, content_repository_ref = ?, r2_bucket_name = ?, r2_manifest_key = ?,
		topology_json = ?, updated_at = ? WHERE project_id = ?`, [
		topology.contentRepository.contentPath, topology.contentRepository.githubUrl ?? null,
		topology.contentRepository.defaultBranch ?? null, topology.contentRepository.ref ?? null,
		topology.contentRepository.r2?.bucketName ?? null, topology.contentRepository.r2?.manifestKey ?? null,
		JSON.stringify(topology), new Date().toISOString(), projectId,
	]);
	return this.getProjectRepositoryTopology(projectId);
}
