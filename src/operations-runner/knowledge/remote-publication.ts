import { resolveGitHubCredentialAuthority } from '../../security/provider-credential-authority.ts';
import { githubRepositoryHead } from '../../providers/github/repository-client.ts';
import { createRemoteGitCredentialDelivery } from '../../security/remote-git-credential-delivery.ts';

const fullHead = (value: string) => value.startsWith('refs/heads/') ? value : `refs/heads/${value}`;

async function observeTreeDxRef(client: any, repositoryId: string, ref: string) {
	const refs: any[] = await client.listRepositoryRefs(repositoryId);
	const observed = refs.find((item) => String(item.name ?? '') === ref);
	return String(observed?.sha ?? observed?.target ?? '') || null;
}

async function requireTreeDxRef(client: any, repositoryId: string, ref: string, expectedHead: string) {
	const head = await observeTreeDxRef(client, repositoryId, ref);
	if (head !== expectedHead) throw new Error(`TreeDX ref ${ref} did not resolve the reviewed publication commit.`);
}

function missingSourceRef(error: unknown) {
	return error instanceof Error && /ref or object not found/iu.test(error.message);
}

async function remoteHead(input: { store: any; binding: any; fetchImpl?: typeof fetch }) {
	const credential = await resolveGitHubCredentialAuthority({
		store: input.store, authorityId: input.binding.authority_id,
		repositoryBindingId: input.binding.id, capability: 'repository-hosting', fetchImpl: input.fetchImpl,
	});
	return githubRepositoryHead(input.fetchImpl ?? fetch, credential.token, input.binding.owner,
		input.binding.name, fullHead(input.binding.publication_ref));
}

export async function publishRemoteRepository(input: {
	store: any; operationId: string; actorId: string; projectId: string; teamId: string;
	connection: any; reviewedCommit: string; baseCommit: string; publicationRef: string; authoringRef: string;
	fetchImpl?: typeof fetch;
}) {
	const binding: any = await input.store.first(`SELECT * FROM project_remote_repository_bindings WHERE project_id = ?`, [input.projectId]);
	if (!binding || binding.grant_status !== 'ready') throw new Error('A ready repository-hosting binding is required for remote publication.');
	if (fullHead(binding.publication_ref) !== fullHead(input.publicationRef)) throw new Error('The reviewed publication ref does not match the repository binding.');
	const observed = await remoteHead({ store: input.store, binding, fetchImpl: input.fetchImpl });
	const expectedRemoteHead = binding.expected_head || null;
	if (observed !== expectedRemoteHead && observed !== input.reviewedCommit) {
		throw new Error('The remote publication ref changed after review. Rebase and review the knowledge again.');
	}
	let push;
	if (observed !== input.reviewedCommit) {
		const destinationRef = fullHead(input.publicationRef);
		const pushFrom = async (sourceRef: string) => {
			const credential = await createRemoteGitCredentialDelivery({
				...input, repositoryBindingId: binding.id, credentialAuthorityId: binding.authority_id,
				nodeId: input.connection.nodeId, sourceRef, destinationRef, expectedRemoteHead, purpose: 'push',
			});
			return input.connection.client.push({ repoId: input.connection.repositoryId,
				remoteName: 'origin', remoteUrl: binding.clone_url, credentialId: credential.deliveryId,
				refspecs: [`${sourceRef}:${destinationRef}`], expectedRemoteHead: expectedRemoteHead ?? '' });
		};
		try { push = await pushFrom(fullHead(input.authoringRef)); }
		catch (error) {
			if (!missingSourceRef(error)) throw error;
			push = await pushFrom(`refs/treedx/commits/${input.reviewedCommit}`);
		}
		if (push.afterHead !== input.reviewedCommit) throw new Error('Remote Git read-back did not match the reviewed commit.');
		const readBack = await remoteHead({ store: input.store, binding, fetchImpl: input.fetchImpl });
		if (readBack !== input.reviewedCommit) throw new Error('The provider remote did not retain the reviewed publication commit.');
	}
	const integrationRef = `refs/heads/treedx/incoming/${input.reviewedCommit}`;
	const fetchCredential = await createRemoteGitCredentialDelivery({
		...input, repositoryBindingId: binding.id, credentialAuthorityId: binding.authority_id,
		nodeId: input.connection.nodeId, sourceRef: fullHead(input.publicationRef),
		destinationRef: integrationRef, expectedRemoteHead: input.reviewedCommit, purpose: 'fetch',
		refspec: `+${fullHead(input.publicationRef)}:${integrationRef}`,
	});
	await input.connection.client.fetchRemote({ repoId: input.connection.repositoryId, remoteName: 'origin',
		remoteUrl: binding.clone_url, credentialId: fetchCredential.deliveryId,
		refspecs: [`+${fullHead(input.publicationRef)}:${integrationRef}`] });
	await requireTreeDxRef(input.connection.client, input.connection.repositoryId, integrationRef, input.reviewedCommit);
	const localPublicationHead = await observeTreeDxRef(input.connection.client, input.connection.repositoryId,
		fullHead(input.publicationRef));
	if (localPublicationHead && localPublicationHead !== input.reviewedCommit && localPublicationHead !== input.baseCommit) {
		throw new Error('The TreeDX publication ref changed after review. Rebase and review the knowledge again.');
	}
	const promotion = localPublicationHead === input.reviewedCommit
		? { status: 'already_current', beforeHead: input.reviewedCommit, afterHead: input.reviewedCommit }
		: await input.connection.client.promoteRef({ repoId: input.connection.repositoryId,
			sourceRef: integrationRef, destinationRef: fullHead(input.publicationRef), expectedDestinationHead: input.baseCommit });
	if (promotion.afterHead !== input.reviewedCommit) throw new Error('TreeDX publication ref did not match the remote reviewed commit.');
	await requireTreeDxRef(input.connection.client, input.connection.repositoryId, fullHead(input.publicationRef), input.reviewedCommit);
	await input.connection.client.retireRef({ repoId: input.connection.repositoryId, ref: integrationRef,
		mergedIntoRef: fullHead(input.publicationRef), expectedHead: input.reviewedCommit,
		expectedMergedIntoHead: input.reviewedCommit });
	const now = new Date().toISOString();
	await input.store.run(`UPDATE project_remote_repository_bindings SET expected_head = ?, observed_head = ?, drift = 'none',
		version = version + 1, updated_at = ? WHERE id = ?`, [input.reviewedCommit, input.reviewedCommit, now, binding.id]);
	return { push, fetch: { ref: integrationRef }, promotion };
}
