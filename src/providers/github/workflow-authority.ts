import { resolveGitHubCredentialAuthority } from '../../security/provider-credential-authority.ts';

export async function resolveWorkflowRunAuthority(input: { store: any; run: any; fetchImpl?: typeof fetch }) {
	const definition = await input.store.first('SELECT * FROM project_workflow_operations WHERE id = ? AND project_id = ?',
		[input.run.operation_id, input.run.project_id]);
	const repository = definition && await input.store.first('SELECT * FROM project_remote_repository_bindings WHERE id = ? AND project_id = ?',
		[definition.repository_binding_id, input.run.project_id]);
	const binding = definition && await input.store.first(`SELECT * FROM team_service_capability_bindings
		WHERE id = ? AND team_id = ? AND capability_type = 'workflow-execution' AND status = 'configured'`,
		[definition.workflow_binding_id, input.run.team_id]);
	const authority = binding && await input.store.first(`SELECT * FROM provider_credential_authorities
		WHERE connection_id = ? AND credential_profile_id = ? AND status = 'ready'`, [binding.connection_id, binding.credential_profile_id]);
	if (!definition || !repository || !binding || !authority || repository.provider_id !== 'github') {
		throw new Error('The workflow provider binding is not ready.');
	}
	const credential = await resolveGitHubCredentialAuthority({ store: input.store, authorityId: authority.id,
		repositoryBindingId: repository.id, capabilityBindingId: binding.id, capability: 'workflow-execution',
		fetchImpl: input.fetchImpl });
	return { definition, repository, binding, authority, credential };
}
