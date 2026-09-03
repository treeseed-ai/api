import {
	clearServiceVaultKey,
	createServiceVaultUserKeyPair,
	openSecretOperationPayload,
} from '@treeseed/sdk/secrets-capability';
import { validateProviderConnection } from './service-validation.ts';

const delay = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export function createServiceCredentialValidationExecutor(options: { controlPlaneStore?: any; fetchImpl?: typeof fetch } = {}) {
	return {
		namespace: 'security',
		operation: 'service-credential-validation',
		async run(input: Record<string, unknown>, context: any) {
			const store = options.controlPlaneStore;
			if (!store) throw new Error('Service credential validation requires the control-plane store.');
			const leaseId = String(input.leaseId ?? ''), teamId = String(input.teamId ?? '');
			const row = await store.first(`SELECT * FROM service_operation_leases
				WHERE id=? AND team_id=? AND purpose='provider-connection-validation' LIMIT 1`, [leaseId, teamId]);
			if (!row || row.status !== 'awaiting-runner' || Date.parse(row.expires_at) <= Date.now())
				throw new Error('The service credential validation lease is unavailable or expired.');
			const pair = await createServiceVaultUserKeyPair();
			try {
				const claimed = await store.run(`UPDATE service_operation_leases SET public_key=?,status='pending',updated_at=?
					WHERE id=? AND status='awaiting-runner' AND expires_at>?`,
				[pair.publicKey, new Date().toISOString(), leaseId, new Date().toISOString()]);
				if (Number(claimed?.meta?.changes ?? claimed?.changes ?? 0) !== 1)
					throw new Error('The service credential validation lease was already claimed.');
				await context.checkpoint({ phase: 'awaiting-sealed-payload', leaseId },
					{ kind: 'service.credential.validation.awaiting_payload', data: { leaseId } });
				let ready: any = null;
				while (Date.now() < Date.parse(row.expires_at)) {
					await context.throwIfCancelled();
					ready = await store.first('SELECT * FROM service_operation_leases WHERE id=?', [leaseId]);
					if (ready?.status === 'ready' && ready.sealed_payload) break;
					if (['cancelled', 'expired', 'failed'].includes(String(ready?.status))) throw new Error('The credential lease ended before payload delivery.');
					await delay(500);
				}
				if (!ready?.sealed_payload) throw new Error('The credential operation lease expired before payload delivery.');
				const values = await openSecretOperationPayload(ready.sealed_payload, pair.publicKey, pair.privateKey);
				const required = JSON.parse(ready.required_fields_json) as string[];
				const supplied = Object.keys(values).sort();
				if (JSON.stringify(supplied) !== JSON.stringify([...required].sort()))
					throw new Error('The sealed credential payload does not contain the exact required fields.');
				const connection = await store.getTeamServiceConnection(teamId, ready.connection_id);
				if (!connection) throw new Error('The service connection no longer exists.');
				await validateProviderConnection(connection, values, options.fetchImpl ?? fetch);
				const completedAt = new Date().toISOString();
				await store.run(`UPDATE service_operation_leases SET sealed_payload=NULL,status='consumed',consumed_at=?,updated_at=?
					WHERE id=? AND status='ready'`, [completedAt, completedAt, leaseId]);
				await store.run('UPDATE team_service_connections SET last_validated_at=?,updated_at=? WHERE id=? AND team_id=?',
					[completedAt, completedAt, connection.id, teamId]);
				await store.run('UPDATE team_service_credential_profiles SET last_validated_at=?,updated_at=? WHERE connection_id=? AND definition_id=?',
					[completedAt, completedAt, connection.id, ready.credential_profile_id]);
				return { ok: true, leaseId, connectionId: connection.id, validatedAt: completedAt };
			} catch (error) {
				await store.run(`UPDATE service_operation_leases SET sealed_payload=NULL,status='failed',updated_at=?
					WHERE id=? AND status NOT IN ('consumed','cancelled')`, [new Date().toISOString(), leaseId]).catch(() => undefined);
				throw error;
			} finally {
				clearServiceVaultKey(pair.privateKey);
			}
		},
	};
}
