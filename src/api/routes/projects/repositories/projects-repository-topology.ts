import { containsForbiddenPlaintextSecretMaterial } from '@treeseed/sdk/secrets-capability';
import { normalizeProjectRepositoryTopology } from '../../../repositories/project-topology.ts';
import { resolveGitHubRepositoryCandidateAuthority } from '../../../../security/provider-credential-authority.ts';
import { resolveGitHubCredentialAuthority } from '../../../../security/provider-credential-authority.ts';
import { githubRepositoryHead, githubRepositoryMetadata } from '../../../../providers/github/repository-client.ts';

const safeRepositoryPart = /^[A-Za-z0-9_.-]+$/u;
const safeRef = /^refs\/heads\/[A-Za-z0-9._/-]+$/u;

async function verifiedTopology(store: any, project: any, input: unknown) {
	const topology = normalizeProjectRepositoryTopology(input);
	const remote = topology.contentRepository.remote;
	if (!remote) return topology;
	if (remote.providerId !== 'github') throw Object.assign(new Error('No repository-hosting adapter is installed for this provider.'), {
		status: 422, code: 'repository_provider_unsupported',
	});
	if (!safeRepositoryPart.test(remote.owner) || !safeRepositoryPart.test(remote.name)
		|| !safeRef.test(remote.defaultRef) || !safeRef.test(remote.publicationRef)
		|| remote.defaultRef.includes('..') || remote.publicationRef.includes('..')) {
		throw Object.assign(new Error('Repository owner, name, or refs are invalid.'), { status: 422, code: 'repository_binding_invalid' });
	}
	const credential = await resolveGitHubRepositoryCandidateAuthority({ store, authorityId: remote.authorityId,
		teamId: project.teamId, serviceConnectionId: remote.serviceConnectionId,
		capabilityBindingId: remote.capabilityBindingId, owner: remote.owner, repository: remote.name });
	const repository = await githubRepositoryMetadata(fetch, credential.token, remote.owner, remote.name);
	if (!repository) throw Object.assign(new Error('The selected provider repository was not found.'), {
		status: 404, code: 'provider_repository_not_found',
	});
	const canonicalOwner = String(repository.owner?.login ?? '');
	const canonicalName = String(repository.name ?? '');
	if (!canonicalOwner || !canonicalName || repository.archived || repository.disabled) {
		throw Object.assign(new Error('The selected provider repository is unavailable for publication.'), { status: 409, code: 'provider_repository_unavailable' });
	}
	const head = await githubRepositoryHead(fetch, credential.token, canonicalOwner, canonicalName, remote.publicationRef);
	return {
		...topology,
		contentRepository: { ...topology.contentRepository,
			githubUrl: String(repository.html_url ?? `https://github.com/${canonicalOwner}/${canonicalName}`),
			remote: { ...remote, providerRepositoryId: String(repository.id), owner: canonicalOwner, name: canonicalName,
				cloneUrl: `https://github.com/${canonicalOwner}/${canonicalName}.git`, expectedHead: head, observedHead: head,
				grantStatus: 'ready' as const, drift: 'none' as const },
		},
	};
}

export function installProjectsRepositoryTopologyRoutes(context: any) {
	const { app, jsonError, requireProjectAccess, store } = context;
	app.get('/v1/projects/:projectId/repository-topology', async (c: any) => {
		const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:read:team');
		if (access.response) return access.response;
		const payload = await store.getProjectRepositoryTopology(c.req.param('projectId'));
		if (!payload) return jsonError(c, 404, 'Project architecture is not configured for this project.', { code: 'project_architecture_not_configured' });
		return c.json({ ok: true, payload });
	});

	app.get('/v1/projects/:projectId/repository-topology/status', async (c: any) => {
		const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:read:team');
		if (access.response) return access.response;
		const binding: any = await store.first(`SELECT * FROM project_remote_repository_bindings WHERE project_id = ?`,
			[c.req.param('projectId')]);
		if (!binding) return jsonError(c, 404, 'The project has no remote repository binding.', { code: 'repository_binding_missing' });
		try {
			const credential = await resolveGitHubCredentialAuthority({ store, authorityId: binding.authority_id,
				repositoryBindingId: binding.id, capabilityBindingId: binding.capability_binding_id,
				capability: 'repository-hosting' });
			const repository = await githubRepositoryMetadata(fetch, credential.token, binding.owner, binding.name);
			if (!repository || String(repository.id) !== String(binding.provider_repository_id)) {
				return jsonError(c, 409, 'The provider repository identity no longer matches the binding.', { code: 'repository_binding_identity_drift' });
			}
			const observedHead = await githubRepositoryHead(fetch, credential.token, binding.owner, binding.name, binding.publication_ref);
			return c.json({ ok: true, payload: { bindingId: binding.id, providerId: binding.provider_id,
				providerRepositoryId: binding.provider_repository_id, cloneUrl: binding.clone_url,
				publicationRef: binding.publication_ref, expectedHead: binding.expected_head,
				observedHead, drift: observedHead === binding.expected_head ? 'none' : 'remote-head-changed',
				grantStatus: binding.grant_status } }, 200, { 'Cache-Control': 'private, no-store' });
		} catch (error: any) {
			return jsonError(c, error?.status ?? 503, error instanceof Error ? error.message : 'Repository provider observation failed.',
				{ code: error?.code ?? 'provider_repository_unavailable' });
		}
	});

	app.put('/v1/projects/:projectId/repository-topology', async (c: any) => {
		const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:manage:team');
		if (access.response) return access.response;
		const body = await c.req.json().catch(() => ({}));
		if (containsForbiddenPlaintextSecretMaterial(body).length) {
			return jsonError(c, 400, 'Repository topology cannot contain credentials or secret material.', { code: 'repository_topology_secret_material_rejected' });
		}
		try {
			const topology = await verifiedTopology(store, access.details.project, body);
			const payload = await store.upsertProjectRepositoryTopology(c.req.param('projectId'), topology);
			if (!payload) return jsonError(c, 404, 'Unknown project.', { code: 'project_not_found' });
			await store.recordAuditEvent({ eventType: 'project.repository.binding_verified', actorType: 'user',
				actorId: access.principal.id, targetType: 'project', targetId: c.req.param('projectId'),
				data: { teamId: access.details.project.teamId, providerId: topology.contentRepository.remote?.providerId ?? null,
					repositoryId: topology.contentRepository.remote?.providerRepositoryId ?? null,
					observedHead: topology.contentRepository.remote?.observedHead ?? null } });
			return c.json({ ok: true, payload });
		} catch (error: any) {
			return jsonError(c, error?.status ?? (error?.code === 'repository_binding_conflict' ? 409 : 400),
				error instanceof Error ? error.message : 'Invalid repository topology.', { code: error?.code ?? 'invalid_repository_topology' });
		}
	});
}
