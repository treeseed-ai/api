import type { MarketControlPlaneStore } from '../../../../persistence/store.ts';

function remote(row: any) {
	if (!row) return null;
	return {
		bindingId: row.id, serviceConnectionId: row.service_connection_id,
		capabilityBindingId: row.capability_binding_id, providerId: row.provider_id,
		providerRepositoryId: row.provider_repository_id, owner: row.owner, name: row.name,
		cloneUrl: row.clone_url, defaultRef: row.default_ref, publicationRef: row.publication_ref,
		authorityId: row.authority_id, expectedHead: row.expected_head, observedHead: row.observed_head,
		grantStatus: row.grant_status, drift: row.drift, version: Number(row.version),
	};
}

export async function getProjectRepositoryTopologyMethod(this: MarketControlPlaneStore, projectId: string) {
	await this.ensureInitialized();
	const library = await this.getProjectTreeDxLibrary(projectId);
	if (!library?.topology?.contentRepository) return null;
	const binding = await this.first(`SELECT * FROM project_remote_repository_bindings WHERE project_id = ?`, [projectId]);
	return {
		...library.topology,
		contentRepository: { ...library.topology.contentRepository, remote: remote(binding) },
	};
}
