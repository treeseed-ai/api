import {
	canonicalHostedSecretOperationBinding,
	clearServiceVaultKey,
	createServiceVaultUserKeyPair,
	openSecretOperationPayload,
	type HostedSecretOperationBinding,
} from '@treeseed/sdk/secrets-capability';
import type { HostedInfrastructureAuthorityRequest } from '@treeseed/deployment/infrastructure/opentofu';

const pause = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function sameRequest(left: any, right: HostedInfrastructureAuthorityRequest) {
	return left?.requestId === right.requestId && left?.connectionId !== ''
		&& left?.credentialProfileId === right.credentialProfileId
		&& left?.provider === right.provider
		&& left?.purpose === right.purpose
		&& left?.secretRef === right.secretRef
		&& JSON.stringify([...(left?.capabilities ?? [])].sort()) === JSON.stringify([...right.capabilities].sort());
}

function materialValues(request: HostedInfrastructureAuthorityRequest, values: Record<string, string>) {
	if (request.credentialProfileId === 's3-state-session') return {
		accessKeyId: values.accessKeyId,
		secretAccessKey: values.secretAccessKey,
		...(values.sessionToken ? { sessionToken: values.sessionToken } : {}),
	};
	if (request.credentialProfileId === 'opentofu-state-encryption') return { key: values.stateEncryptionKey };
	return { apiToken: values.apiToken };
}

export async function withHostedClientVaultLeases<T>(input: {
	store: any;
	teamId: string;
	leaseIds?: unknown;
	purpose: string;
	binding: HostedSecretOperationBinding;
	context: any;
	run(resolver?: (request: HostedInfrastructureAuthorityRequest) => Promise<any>): Promise<T>;
}): Promise<T> {
	const ids = Array.isArray(input.leaseIds) ? input.leaseIds.map(String) : [];
	if (!ids.length) return input.run(undefined);
	if (new Set(ids).size !== ids.length) throw new Error('Hosted credential lease IDs must be unique.');
	const sessions: Array<{ row: any; privateKey: Uint8Array; publicKey: string; values?: Record<string, string> }> = [];
	try {
		for (const id of ids) {
			const row = await input.store.first('SELECT * FROM service_operation_leases WHERE id=? AND team_id=?', [id, input.teamId]);
			if (!row || row.purpose !== input.purpose || row.status !== 'awaiting-runner' || Date.parse(row.expires_at) <= Date.now())
				throw new Error('Hosted credential lease is missing, expired, already used, or has the wrong purpose.');
			const storedBinding = JSON.parse(row.hosted_binding_json ?? 'null');
			if (canonicalHostedSecretOperationBinding(storedBinding) !== canonicalHostedSecretOperationBinding(input.binding))
				throw new Error('Hosted credential lease does not bind the exact deployment subject.');
			const pair = await createServiceVaultUserKeyPair();
			const claimed = await input.store.run(`UPDATE service_operation_leases SET public_key=?,status='pending',updated_at=?
				WHERE id=? AND status='awaiting-runner' AND expires_at>?`,
			[pair.publicKey, new Date().toISOString(), id, new Date().toISOString()]);
			if (Number(claimed?.meta?.changes ?? claimed?.changes ?? 0) !== 1) {
				clearServiceVaultKey(pair.privateKey); throw new Error('Hosted credential lease was concurrently claimed.');
			}
			sessions.push({ row, privateKey: pair.privateKey, publicKey: pair.publicKey });
		}
		await input.context.checkpoint({ phase: 'awaiting-hosted-credentials', leaseIds: ids },
			{ kind: 'infrastructure.hosted.awaiting_credentials', data: { leaseIds: ids } });
		while (sessions.some(({ values }) => !values)) {
			await input.context.throwIfCancelled();
			for (const session of sessions.filter(({ values }) => !values)) {
				const current = await input.store.first('SELECT * FROM service_operation_leases WHERE id=?', [session.row.id]);
				if (current?.status === 'ready' && current.sealed_payload) {
					const values = await openSecretOperationPayload(current.sealed_payload, session.publicKey, session.privateKey);
					const required = JSON.parse(current.required_fields_json) as string[];
					if (JSON.stringify(Object.keys(values).sort()) !== JSON.stringify([...required].sort()))
						throw new Error('Hosted credential payload does not contain the exact profile fields.');
					session.values = values;
				} else if (!current || ['cancelled', 'expired', 'failed', 'consumed'].includes(String(current.status))
					|| Date.parse(current.expires_at) <= Date.now()) throw new Error('Hosted credential lease ended before payload delivery.');
			}
			if (sessions.some(({ values }) => !values)) await pause(500);
		}
		const resolver = async (request: HostedInfrastructureAuthorityRequest) => {
			const session = sessions.find(({ row }) => (JSON.parse(row.authority_requests_json ?? '[]') as any[]).some((entry) => sameRequest(entry, request)));
			if (!session?.values) throw new Error(`No client-encrypted lease authorizes hosted request ${request.requestId}.`);
			const authority = await input.store.first(`SELECT a.* FROM provider_credential_authorities a
				JOIN team_service_connections c ON c.id=a.connection_id AND c.team_id=a.team_id
				WHERE a.team_id=? AND a.connection_id=? AND a.credential_profile_id=? AND a.scheme='client-encrypted'
				AND a.status='interactive-only'`, [input.teamId, session.row.connection_id, session.row.credential_profile_id]);
			if (!authority) throw new Error('The client-encrypted hosted authority changed after lease approval.');
			return { values: materialValues(request, session.values), expiresAt: session.row.expires_at,
				authorityId: authority.id, authorityVersion: Number(authority.version) };
		};
		const result = await input.run(resolver);
		const completedAt = new Date().toISOString();
		for (const session of sessions) await input.store.run(`UPDATE service_operation_leases
			SET sealed_payload=NULL,status='consumed',consumed_at=?,updated_at=? WHERE id=? AND status='ready'`,
		[completedAt, completedAt, session.row.id]);
		return result;
	} catch (error) {
		for (const session of sessions) await input.store.run(`UPDATE service_operation_leases
			SET sealed_payload=NULL,status='failed',updated_at=? WHERE id=? AND status NOT IN ('consumed','cancelled')`,
		[new Date().toISOString(), session.row.id]).catch(() => undefined);
		throw error;
	} finally {
		for (const session of sessions) clearServiceVaultKey(session.privateKey);
	}
}
