import { randomUUID } from 'node:crypto';
import { githubRepositoryHead, githubRepositoryMetadata } from '../../../../providers/github/repository-client.ts';
import { resolveGitHubRepositoryCandidateAuthority } from '../../../../security/provider-credential-authority.ts';
import { createRemoteGitCredentialDelivery } from '../../../../security/remote-git-credential-delivery.ts';

const repositoryPart = /^[A-Za-z0-9_.-]+$/u;
const exactCommit = /^[a-f0-9]{40}$/u;
const gitRef = /^refs\/(?:heads|remotes)\/[A-Za-z0-9._/-]+$/u;

function text(value: unknown) {
	return typeof value === 'string' ? value.trim() : '';
}

export async function prepareTreeDxCredentialDelivery(input: {
	store: any;
	body: Record<string, unknown>;
	env?: NodeJS.ProcessEnv;
	fetchImpl?: typeof fetch;
}) {
	const teamSlug = text(input.body.teamSlug);
	const projectSlug = text(input.body.projectSlug);
	const owner = text(input.body.owner);
	const name = text(input.body.name);
	const nodeId = text(input.body.nodeId);
	const sourceRef = text(input.body.sourceRef);
	const destinationRef = text(input.body.destinationRef);
	const expectedHead = text(input.body.expectedRemoteHead);
	const idempotencyKey = text(input.body.idempotencyKey);
	const refspec = text(input.body.refspec);
	const operationKind = text(input.body.operationKind) || 'fetch';
	if (![teamSlug, projectSlug, owner, name, nodeId, sourceRef, destinationRef, idempotencyKey, refspec].every(Boolean)
		|| !repositoryPart.test(owner) || !repositoryPart.test(name) || !gitRef.test(sourceRef)
		|| !gitRef.test(destinationRef) || (expectedHead && !exactCommit.test(expectedHead))
		|| !['fetch', 'push'].includes(operationKind) || idempotencyKey.length > 240) {
		throw Object.assign(new Error('A bounded exact repository credential-delivery scope is required.'), {
			status: 422, code: 'credential_delivery_scope_invalid',
		});
	}
	const project: any = await input.store.first(
		`SELECT p.*, t.slug AS team_slug FROM projects p JOIN teams t ON t.id = p.team_id
		 WHERE p.slug = ? AND t.slug = ?`, [projectSlug, teamSlug],
	);
	if (!project) throw Object.assign(new Error('The selected team project is unavailable.'), { status: 404, code: 'project_not_found' });
	const service: any = await input.store.first(
		`SELECT c.id AS connection_id, b.id AS capability_binding_id, b.credential_profile_id,
		 a.id AS authority_id, a.reference AS authority_reference
		 FROM team_service_connections c
		 JOIN team_service_capability_bindings b ON b.connection_id = c.id AND b.team_id = c.team_id
		  AND b.capability_type = 'repository-hosting' AND b.status = 'configured'
		 JOIN provider_credential_authorities a ON a.connection_id = c.id
		  AND a.credential_profile_id = b.credential_profile_id AND a.status IN ('ready', 'interactive-only')
		 WHERE c.team_id = ? AND c.provider_id = 'github' AND c.status = 'active'
		 ORDER BY CASE WHEN b.credential_profile_id = 'github-repository-token' THEN 0 ELSE 1 END LIMIT 1`,
		[project.team_id],
	);
	if (!service) throw Object.assign(new Error('The team GitHub repository-hosting authority is unavailable.'), {
		status: 409, code: 'repository_authority_unavailable',
	});
	if (owner.toLowerCase() === 'treeseed-ai' && service.authority_reference !== 'TREESEED_GITHUB_TOKEN') {
		await input.store.run(`UPDATE provider_credential_authorities SET reference = 'TREESEED_GITHUB_TOKEN',
		 status = 'ready', version = version + 1, updated_at = ? WHERE id = ?`,
		[new Date().toISOString(), service.authority_id]);
	}
	const credential = await resolveGitHubRepositoryCandidateAuthority({
		store: input.store, authorityId: service.authority_id, teamId: project.team_id,
		serviceConnectionId: service.connection_id, capabilityBindingId: service.capability_binding_id,
		owner, repository: name, env: input.env, fetchImpl: input.fetchImpl,
	});
	const providerFetch = input.fetchImpl ?? fetch;
	const repository = await githubRepositoryMetadata(providerFetch, credential.token, owner, name);
	if (!repository || repository.archived || repository.disabled) {
		throw Object.assign(new Error('The content repository is unavailable.'), { status: 409, code: 'repository_unavailable' });
	}
	const canonicalOwner = text(repository.owner?.login);
	const canonicalName = text(repository.name);
	const observedHead = await githubRepositoryHead(providerFetch, credential.token, canonicalOwner, canonicalName, sourceRef);
	if (!observedHead || (expectedHead && observedHead !== expectedHead)) throw Object.assign(new Error('The content repository changed after reconciliation planning.'), {
		status: 409, code: 'repository_head_changed',
	});
	const remoteHead = expectedHead || observedHead;
	const existing: any = await input.store.first(`SELECT * FROM project_remote_repository_bindings WHERE project_id = ?`, [project.id]);
	const bindingId = existing?.id ?? randomUUID();
	const now = new Date().toISOString();
	await input.store.run(
		`INSERT INTO project_remote_repository_bindings (id, project_id, team_id, service_connection_id,
		 capability_binding_id, provider_id, provider_repository_id, owner, name, clone_url, default_ref,
		 publication_ref, authority_id, expected_head, observed_head, grant_status, drift, version, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, 'github', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', 'none', 1, ?, ?)
		 ON CONFLICT(project_id) DO UPDATE SET service_connection_id = excluded.service_connection_id,
		 capability_binding_id = excluded.capability_binding_id, provider_id = excluded.provider_id,
		 provider_repository_id = excluded.provider_repository_id, owner = excluded.owner, name = excluded.name,
		 clone_url = excluded.clone_url, default_ref = excluded.default_ref, publication_ref = excluded.publication_ref,
		 authority_id = excluded.authority_id, expected_head = excluded.expected_head, observed_head = excluded.observed_head,
		 grant_status = 'ready', drift = 'none', version = project_remote_repository_bindings.version + 1,
		 updated_at = excluded.updated_at`,
		[bindingId, project.id, project.team_id, service.connection_id, service.capability_binding_id,
			String(repository.id), canonicalOwner, canonicalName, `https://github.com/${canonicalOwner}/${canonicalName}.git`,
			 sourceRef, sourceRef, service.authority_id, remoteHead, remoteHead, now, now],
	);
	const delivery = await createRemoteGitCredentialDelivery({
		store: input.store, operationId: `treedx-reconcile:${idempotencyKey}`, actorId: 'platform-runner',
		teamId: project.team_id, projectId: project.id, repositoryBindingId: bindingId,
		credentialAuthorityId: service.authority_id, nodeId, sourceRef, destinationRef,
		reviewedCommit: remoteHead, expectedRemoteHead: remoteHead, purpose: operationKind as 'fetch' | 'push', refspec,
	});
	await input.store.recordAuditEvent({ eventType: 'treedx.credential_delivery.prepared', actorType: 'service',
		actorId: 'platform-runner', targetType: 'remote_credential_delivery', targetId: delivery.deliveryId,
		data: { teamId: project.team_id, projectId: project.id, repositoryBindingId: bindingId,
			owner: canonicalOwner, name: canonicalName, nodeId, sourceRef, destinationRef, expectedHead: remoteHead, operationKind } });
	return { ...delivery, repositoryBindingId: bindingId, owner: canonicalOwner, name: canonicalName,
		remoteUrl: `https://github.com/${canonicalOwner}/${canonicalName}.git`, expectedRemoteHead: remoteHead };
}
