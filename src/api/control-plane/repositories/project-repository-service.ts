import { createHash } from 'node:crypto';
import { containsForbiddenPlaintextSecretMaterial } from '@treeseed/sdk/secrets-capability';
import { githubRepositoryHead, githubRepositoryMetadata } from '../../../providers/github/repository-client.ts';
import { normalizeProjectRepositoryTopology } from '../../repositories/project-topology.ts';
import { resolveGitHubCredentialAuthority, resolveGitHubRepositoryCandidateAuthority } from '../../../security/provider-credential-authority.ts';
import { RepositoryOperationError } from './repository-operation-error.ts';

type Principal = { id: string; roles?: string[]; permissions?: string[] } | undefined;

function etag(value: unknown) {
	return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function administrator(principal: NonNullable<Principal>) {
	return principal.roles?.some((role) => role === 'admin' || role === 'platform_admin')
		|| principal.permissions?.includes('*:*:*') || false;
}

async function access(store: any, principal: Principal, projectId: string, permission: 'projects:read:team' | 'projects:manage:team') {
	if (!principal) throw new RepositoryOperationError(401, 'authentication_required', 'Authentication is required.');
	const details = await store.getProjectDetails(projectId);
	if (!details?.project) throw new RepositoryOperationError(404, 'project_not_found', 'The project was not found.');
	if (!administrator(principal) && !await store.principalCanAccessTeam(principal, details.project.teamId)) {
		throw new RepositoryOperationError(403, 'repository_access_denied', 'The principal cannot access this project repository.');
	}
	if (principal.roles?.includes('team_api_key') && !principal.permissions?.some((entry) => entry === '*:*:*' || entry === permission)) {
		throw new RepositoryOperationError(403, 'repository_permission_denied', `The credential requires ${permission}.`);
	}
	if (permission === 'projects:manage:team' && !principal.roles?.includes('team_api_key')
		&& !administrator(principal) && !await store.principalCanManageTeam(principal, details.project.teamId)) {
		throw new RepositoryOperationError(403, 'repository_management_denied', 'Team management authority is required.');
	}
	return { principal, project: details.project };
}

const safeRepositoryPart = /^[A-Za-z0-9_.-]+$/u;
const safeRef = /^refs\/heads\/[A-Za-z0-9._/-]+$/u;

async function verifiedTopology(store: any, project: any, input: unknown, currentVersion: number) {
	const topology = normalizeProjectRepositoryTopology(input);
	const remote = topology.contentRepository.remote;
	if (!remote) return topology;
	if (remote.version !== currentVersion) {
		throw new RepositoryOperationError(412, 'repository_topology_version_mismatch', 'The topology body does not identify the current repository binding version.');
	}
	if (remote.providerId !== 'github') throw new RepositoryOperationError(422, 'repository_provider_unsupported', 'No repository-hosting adapter is installed for this provider.');
	if (!safeRepositoryPart.test(remote.owner) || !safeRepositoryPart.test(remote.name)
		|| !safeRef.test(remote.defaultRef) || !safeRef.test(remote.publicationRef)
		|| remote.defaultRef.includes('..') || remote.publicationRef.includes('..')) {
		throw new RepositoryOperationError(422, 'repository_binding_invalid', 'Repository owner, name, or refs are invalid.');
	}
	const credential = await resolveGitHubRepositoryCandidateAuthority({ store, authorityId: remote.authorityId,
		teamId: project.teamId, serviceConnectionId: remote.serviceConnectionId,
		capabilityBindingId: remote.capabilityBindingId, owner: remote.owner, repository: remote.name });
	const repository = await githubRepositoryMetadata(fetch, credential.token, remote.owner, remote.name);
	if (!repository) throw new RepositoryOperationError(404, 'provider_repository_not_found', 'The selected provider repository was not found.');
	const owner = String(repository.owner?.login ?? '');
	const name = String(repository.name ?? '');
	if (!owner || !name || repository.archived || repository.disabled) {
		throw new RepositoryOperationError(409, 'provider_repository_unavailable', 'The selected provider repository is unavailable for publication.');
	}
	const head = await githubRepositoryHead(fetch, credential.token, owner, name, remote.publicationRef);
	return { ...topology, contentRepository: { ...topology.contentRepository,
		githubUrl: String(repository.html_url ?? `https://github.com/${owner}/${name}`),
		remote: { ...remote, providerRepositoryId: String(repository.id), owner, name,
			cloneUrl: `https://github.com/${owner}/${name}.git`, expectedHead: head, observedHead: head,
			grantStatus: 'ready' as const, drift: 'none' as const } } };
}

export function createProjectRepositoryService(store: any) {
	return {
		async topology(principal: Principal, projectId: string) {
			await access(store, principal, projectId, 'projects:read:team');
			const topology = await store.getProjectRepositoryTopology(projectId);
			if (!topology) throw new RepositoryOperationError(404, 'project_architecture_not_configured', 'Project architecture is not configured.');
			return topology;
		},
		async status(principal: Principal, projectId: string) {
			await access(store, principal, projectId, 'projects:read:team');
			const binding: any = await store.first('SELECT * FROM project_remote_repository_bindings WHERE project_id = ?', [projectId]);
			if (!binding) throw new RepositoryOperationError(404, 'repository_binding_missing', 'The project has no remote repository binding.');
			try {
				const credential = await resolveGitHubCredentialAuthority({ store, authorityId: binding.authority_id,
					repositoryBindingId: binding.id, capabilityBindingId: binding.capability_binding_id, capability: 'repository-hosting' });
				const repository = await githubRepositoryMetadata(fetch, credential.token, binding.owner, binding.name);
				if (!repository || String(repository.id) !== String(binding.provider_repository_id)) {
					throw new RepositoryOperationError(409, 'repository_binding_identity_drift', 'The provider repository identity no longer matches the binding.');
				}
				const observedHead = await githubRepositoryHead(fetch, credential.token, binding.owner, binding.name, binding.publication_ref);
				return { bindingId: binding.id, providerId: binding.provider_id, providerRepositoryId: binding.provider_repository_id,
					cloneUrl: binding.clone_url, publicationRef: binding.publication_ref, expectedHead: binding.expected_head,
					observedHead, drift: observedHead === binding.expected_head ? 'none' : 'remote-head-changed', grantStatus: binding.grant_status };
			} catch (error) {
				if (error instanceof RepositoryOperationError) throw error;
				const value = error as { status?: number; code?: string; message?: string };
				throw new RepositoryOperationError(value.status === 404 ? 404 : 503, value.code ?? 'provider_repository_unavailable', value.message ?? 'Repository provider observation failed.');
			}
		},
		async update(principal: Principal, projectId: string, body: Record<string, unknown>, ifMatch?: string) {
			const granted = await access(store, principal, projectId, 'projects:manage:team');
			if (containsForbiddenPlaintextSecretMaterial(body).length) {
				throw new RepositoryOperationError(400, 'repository_topology_secret_material_rejected', 'Repository topology cannot contain credentials or secret material.');
			}
			const current = await store.getProjectRepositoryTopology(projectId);
			if (!current) throw new RepositoryOperationError(404, 'project_architecture_not_configured', 'Project architecture is not configured.');
			if (!ifMatch || ifMatch !== etag(current)) {
				throw new RepositoryOperationError(412, 'repository_topology_precondition_failed', 'The repository topology changed after it was inspected.');
			}
			try {
				const topology = await verifiedTopology(store, granted.project, body, Number(current.contentRepository?.remote?.version ?? 1));
				const updated = await store.upsertProjectRepositoryTopology(projectId, topology);
				if (!updated) throw new RepositoryOperationError(404, 'project_not_found', 'The project was not found.');
				await store.recordAuditEvent({ eventType: 'project.repository.binding_verified', actorType: 'user', actorId: granted.principal.id,
					targetType: 'project', targetId: projectId, data: { teamId: granted.project.teamId,
						providerId: topology.contentRepository.remote?.providerId ?? null,
						repositoryId: topology.contentRepository.remote?.providerRepositoryId ?? null,
						observedHead: topology.contentRepository.remote?.observedHead ?? null } });
				return updated;
			} catch (error) {
				if (error instanceof RepositoryOperationError) throw error;
				const value = error as { code?: string; message?: string };
				throw new RepositoryOperationError(value.code === 'repository_binding_conflict' ? 409 : 400,
					value.code ?? 'invalid_repository_topology', value.message ?? 'Invalid repository topology.');
			}
		},
	};
}
