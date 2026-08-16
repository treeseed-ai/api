import { createHash, randomUUID } from 'node:crypto';

export async function createRemoteGitCredentialDelivery(input: {
	store: any;
	operationId: string;
	actorId: string;
	teamId: string;
	projectId: string;
	repositoryBindingId: string;
	credentialAuthorityId: string;
	nodeId: string;
	sourceRef: string;
	destinationRef: string;
	reviewedCommit: string;
	expectedRemoteHead: string | null;
	purpose: 'push' | 'fetch';
	refspec?: string;
}) {
	const now = new Date();
	const expiresAt = new Date(now.getTime() + 120_000).toISOString();
	const idempotencyBase = `${input.operationId}:${input.purpose}:${input.reviewedCommit}`;
	const attempts: any[] = await input.store.all(
		`SELECT g.id, g.expires_at AS grant_expires_at, d.id AS delivery_id, d.status, d.expires_at FROM remote_git_operation_grants g
		 LEFT JOIN remote_credential_deliveries d ON d.grant_id = g.id
		 WHERE g.operation_id = ? AND g.idempotency_key LIKE ? ORDER BY g.created_at`,
		[input.operationId, `${idempotencyBase}:%`],
	);
	const reusable = attempts.findLast((item) => item.status === 'ready' && Date.parse(item.expires_at) > Date.now());
	if (reusable) return { deliveryId: reusable.delivery_id as string, expiresAt: reusable.expires_at as string, reused: true };

	const partial = attempts.findLast((item) => !item.delivery_id && Date.parse(item.grant_expires_at) > Date.now());
	const grantId = partial?.id ?? randomUUID();
	const candidateDeliveryId = randomUUID();
	const idempotencyKey = `${idempotencyBase}:${partial ? attempts.indexOf(partial) + 1 : attempts.length + 1}`;
	const refspec = input.refspec ?? `${input.sourceRef}:${input.destinationRef}`;
	const digest = createHash('sha256').update(refspec).digest('hex');
	if (!partial) {
		await input.store.run(
			`INSERT INTO remote_git_operation_grants (id, operation_id, actor_id, team_id, project_id, repository_binding_id,
			 treedx_node_id, source_ref, destination_ref, reviewed_commit, expected_remote_head, credential_authority_id,
			 status, expires_at, idempotency_key, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'delivered', ?, ?, ?, ?)
			 ON CONFLICT(idempotency_key) DO NOTHING`,
			[grantId, input.operationId, input.actorId, input.teamId, input.projectId, input.repositoryBindingId, input.nodeId,
				input.sourceRef, input.destinationRef, input.reviewedCommit, input.expectedRemoteHead ?? '',
				input.credentialAuthorityId, expiresAt, idempotencyKey, now.toISOString(), now.toISOString()],
		);
	}
	const grant: any = await input.store.first(`SELECT * FROM remote_git_operation_grants WHERE idempotency_key = ?`, [idempotencyKey]);
	await input.store.run(
		`INSERT INTO remote_credential_deliveries (id, grant_id, operation_id, node_id, allowed_host, refspec_digest,
		 operation_kind, delivery_mode, ciphertext, algorithm, status, expires_at, created_at, updated_at)
		 VALUES (?, ?, ?, ?, 'github.com', ?, ?, 'sealed', NULL, 'x25519-hkdf-sha256-chacha20-poly1305/v1', 'ready', ?, ?, ?)
		 ON CONFLICT(grant_id) DO NOTHING`,
		[candidateDeliveryId, grant.id, input.operationId, input.nodeId, digest, input.purpose,
			expiresAt, now.toISOString(), now.toISOString()],
	);
	const delivery: any = await input.store.first(`SELECT * FROM remote_credential_deliveries WHERE grant_id = ?`, [grant.id]);
	if (!delivery) throw new Error('The remote Git credential delivery could not be recovered.');
	return { deliveryId: delivery.id as string, expiresAt: delivery.expires_at as string,
		reused: delivery.id !== candidateDeliveryId };
}
