import { createHash, randomUUID } from 'node:crypto';
import { resolveGitHubCredentialAuthority } from '../../security/provider-credential-authority.ts';
import { githubRepositoryHead } from '../../providers/github/repository-client.ts';

const fullHead = (value: string) => value.startsWith('refs/heads/') ? value : `refs/heads/${value}`;
const branchName = (value: string) => fullHead(value).slice('refs/heads/'.length);

async function observeTreeDxRef(client: any, repositoryId: string, ref: string) {
	const refs: any[] = await client.listRepositoryRefs(repositoryId);
	const observed = refs.find((item) => String(item.name ?? '') === ref);
	return String(observed?.sha ?? observed?.target ?? '') || null;
}

async function requireTreeDxRef(client: any, repositoryId: string, ref: string, expectedHead: string) {
	const head = await observeTreeDxRef(client, repositoryId, ref);
	if (head !== expectedHead) throw new Error(`TreeDX ref ${ref} did not resolve the reviewed publication commit.`);
}

async function remoteHead(input: { store: any; binding: any; fetchImpl?: typeof fetch }) {
	const credential = await resolveGitHubCredentialAuthority({
		store: input.store, authorityId: input.binding.authority_id,
		repositoryBindingId: input.binding.id, capability: 'repository-hosting', fetchImpl: input.fetchImpl,
	});
	return githubRepositoryHead(input.fetchImpl ?? fetch, credential.token, input.binding.owner,
		input.binding.name, input.binding.publication_ref);
}

async function createDelivery(input: {
	store: any; operationId: string; actorId: string; projectId: string; teamId: string;
	binding: any; nodeId: string; sourceRef: string; destinationRef: string; reviewedCommit: string;
	expectedRemoteHead: string | null; purpose: 'push' | 'fetch';
	refspec?: string;
}) {
	const grantId = randomUUID();
	const deliveryId = randomUUID();
	const now = new Date();
	const expiresAt = new Date(now.getTime() + 120_000).toISOString();
	const idempotencyBase = `${input.operationId}:${input.purpose}:${input.reviewedCommit}`;
	const attempts: any[] = await input.store.all(
		`SELECT g.id, d.id AS delivery_id, d.status, d.expires_at FROM remote_git_operation_grants g
		 LEFT JOIN remote_credential_deliveries d ON d.grant_id = g.id
		 WHERE g.operation_id = ? AND g.idempotency_key LIKE ? ORDER BY g.created_at`,
		[input.operationId, `${idempotencyBase}:%`],
	);
	const reusable = attempts.findLast((item) => item.status === 'ready' && Date.parse(item.expires_at) > Date.now());
	if (reusable) return reusable.delivery_id;
	const idempotencyKey = `${idempotencyBase}:${attempts.length + 1}`;
	const refspec = input.refspec ?? `${input.sourceRef}:${input.destinationRef}`;
	const digest = createHash('sha256').update(refspec).digest('hex');
	await input.store.run(
		`INSERT INTO remote_git_operation_grants (id, operation_id, actor_id, team_id, project_id, repository_binding_id,
		 treedx_node_id, source_ref, destination_ref, reviewed_commit, expected_remote_head, credential_authority_id,
		 status, expires_at, idempotency_key, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'delivered', ?, ?, ?, ?)
		 ON CONFLICT(idempotency_key) DO NOTHING`,
		[grantId, input.operationId, input.actorId, input.teamId, input.projectId, input.binding.id, input.nodeId,
			input.sourceRef, input.destinationRef, input.reviewedCommit, input.expectedRemoteHead ?? '',
			input.binding.authority_id, expiresAt, idempotencyKey, now.toISOString(), now.toISOString()],
	);
	const grant: any = await input.store.first(`SELECT * FROM remote_git_operation_grants WHERE idempotency_key = ?`, [idempotencyKey]);
	await input.store.run(
		`INSERT INTO remote_credential_deliveries (id, grant_id, operation_id, node_id, allowed_host, refspec_digest,
		 operation_kind, delivery_mode, ciphertext, algorithm, status, expires_at, created_at, updated_at)
		 VALUES (?, ?, ?, ?, 'github.com', ?, ?, 'sealed', NULL, 'x25519-hkdf-sha256-chacha20-poly1305/v1', 'ready', ?, ?, ?)`,
		[deliveryId, grant.id, input.operationId, input.nodeId, digest, input.purpose,
			expiresAt, now.toISOString(), now.toISOString()],
	);
	return deliveryId;
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
		const credentialId = await createDelivery({
			...input, binding, nodeId: input.connection.nodeId, sourceRef: fullHead(input.authoringRef),
			destinationRef: fullHead(input.publicationRef), expectedRemoteHead, purpose: 'push',
		});
		push = await input.connection.client.push({ repoId: input.connection.repositoryId, remoteName: 'origin',
			remoteUrl: binding.clone_url, credentialId,
			refspecs: [`${fullHead(input.authoringRef)}:${fullHead(input.publicationRef)}`], expectedRemoteHead: expectedRemoteHead ?? '' });
		if (push.afterHead !== input.reviewedCommit) throw new Error('Remote Git read-back did not match the reviewed commit.');
		const readBack = await remoteHead({ store: input.store, binding, fetchImpl: input.fetchImpl });
		if (readBack !== input.reviewedCommit) throw new Error('The provider remote did not retain the reviewed publication commit.');
	}
	const remoteTrackingRef = `refs/remotes/origin/${branchName(input.publicationRef)}`;
	const fetchCredentialId = await createDelivery({
		...input, binding, nodeId: input.connection.nodeId, sourceRef: fullHead(input.publicationRef),
		destinationRef: remoteTrackingRef, expectedRemoteHead: input.reviewedCommit, purpose: 'fetch',
		refspec: `+${fullHead(input.publicationRef)}:${remoteTrackingRef}`,
	});
	await input.connection.client.fetchRemote({ repoId: input.connection.repositoryId, remoteName: 'origin',
		remoteUrl: binding.clone_url, credentialId: fetchCredentialId,
		refspecs: [`+${fullHead(input.publicationRef)}:${remoteTrackingRef}`] });
	await requireTreeDxRef(input.connection.client, input.connection.repositoryId, remoteTrackingRef, input.reviewedCommit);
	const localPublicationHead = await observeTreeDxRef(input.connection.client, input.connection.repositoryId,
		fullHead(input.publicationRef));
	if (localPublicationHead !== input.reviewedCommit && localPublicationHead !== input.baseCommit) {
		throw new Error('The TreeDX publication ref changed after review. Rebase and review the knowledge again.');
	}
	const promotion = localPublicationHead === input.reviewedCommit
		? { status: 'already_current', beforeHead: input.reviewedCommit, afterHead: input.reviewedCommit }
		: await input.connection.client.promoteRef({ repoId: input.connection.repositoryId,
			sourceRef: remoteTrackingRef, destinationRef: fullHead(input.publicationRef), expectedDestinationHead: input.baseCommit });
	if (promotion.afterHead !== input.reviewedCommit) throw new Error('TreeDX publication ref did not match the remote reviewed commit.');
	await requireTreeDxRef(input.connection.client, input.connection.repositoryId, fullHead(input.publicationRef), input.reviewedCommit);
	const now = new Date().toISOString();
	await input.store.run(`UPDATE project_remote_repository_bindings SET expected_head = ?, observed_head = ?, drift = 'none',
		version = version + 1, updated_at = ? WHERE id = ?`, [input.reviewedCommit, input.reviewedCommit, now, binding.id]);
	return { push, fetch: { ref: remoteTrackingRef }, promotion };
}
