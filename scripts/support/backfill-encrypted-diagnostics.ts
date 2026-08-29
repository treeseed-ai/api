import { Pool, type PoolClient } from 'pg';
import { pathToFileURL } from 'node:url';
import { createDiagnosticEnvelopeService } from '../../src/security/diagnostic-envelope.ts';
import { CapacitySecretCodec } from '../../src/api/capacity/security.ts';
import { readFileSync } from 'node:fs';

interface TraceRow {
	id: string; team_id: string; topic_id: string | null; send_id: string | null; invocation_id: string | null;
	assignment_id: string; sequence: number; event_type: string; protected_payload_json: Record<string, unknown>;
}

async function batch(client: PoolClient, limit: number) {
	await client.query('BEGIN');
	try {
		const selected = await client.query<TraceRow>(`SELECT id,team_id,topic_id,send_id,invocation_id,assignment_id,sequence,event_type,protected_payload_json
			FROM communication_execution_trace_events WHERE protected_payload_json IS NOT NULL AND protected_payload_envelope_json IS NULL
			ORDER BY assignment_id,sequence LIMIT $1 FOR UPDATE SKIP LOCKED`, [limit]);
		const envelopes = createDiagnosticEnvelopeService(process.env);
		for (const row of selected.rows) {
			const envelope = envelopes.encrypt(row.protected_payload_json, { teamId: row.team_id, resourceId: row.id,
				...(row.topic_id ? { topicId: row.topic_id } : {}), ...(row.send_id ? { sendId: row.send_id } : {}), ...(row.invocation_id ? { invocationId: row.invocation_id } : {}),
				assignmentId: row.assignment_id, sequence: Number(row.sequence), eventType: row.event_type });
			await client.query(`UPDATE communication_execution_trace_events SET protected_payload_envelope_json=$1::jsonb,
				protected_payload_digest=$2,protected_payload_key_id=$3,protected_payload_key_version=$4,protected_payload_json=NULL WHERE id=$5 AND protected_payload_json IS NOT NULL`,
				[JSON.stringify(envelope), envelope.ciphertextDigest, envelope.keyId, envelope.keyVersion, row.id]);
		}
		await client.query('COMMIT'); return selected.rowCount ?? 0;
	} catch (error) { await client.query('ROLLBACK'); throw error; }
}

async function rewrapBatch(client: PoolClient, limit: number) {
	await client.query('BEGIN');
	try {
		const diagnosticsVersion = Math.max(1, Number(process.env.TREESEED_DIAGNOSTICS_KEY_VERSION ?? 1)), envelopes = createDiagnosticEnvelopeService(process.env);
		const traces = await client.query<{ id: string; protected_payload_envelope_json: Record<string, unknown> }>(`SELECT id,protected_payload_envelope_json FROM communication_execution_trace_events
			WHERE protected_payload_envelope_json IS NOT NULL AND protected_payload_key_version<>$1 ORDER BY id LIMIT $2 FOR UPDATE SKIP LOCKED`, [diagnosticsVersion, limit]);
		for (const row of traces.rows) { const envelope = envelopes.rewrap(row.protected_payload_envelope_json); await client.query('UPDATE communication_execution_trace_events SET protected_payload_envelope_json=$1::jsonb,protected_payload_key_id=$2,protected_payload_key_version=$3 WHERE id=$4', [JSON.stringify(envelope), envelope.keyId, envelope.keyVersion, row.id]); }
		const capacitySecret = process.env.TREESEED_CAPACITY_ENCRYPTION_KEY_FILE ? readFileSync(process.env.TREESEED_CAPACITY_ENCRYPTION_KEY_FILE, 'utf8').trim() : String(process.env.TREESEED_CAPACITY_ENCRYPTION_KEY ?? '');
		const historical = String(process.env.TREESEED_CAPACITY_HISTORICAL_KEY_FILES ?? '').split(',').map((entry) => entry.trim()).filter(Boolean).map((entry) => { const match = /^(\d+):(.+)$/u.exec(entry); if (!match) throw new Error('Historical capacity keys must use VERSION:/absolute/path entries.'); return { version: Number(match[1]), secret: readFileSync(match[2]!, 'utf8').trim() }; });
		const capacityVersion = Math.max(1, Number(process.env.TREESEED_CAPACITY_ENCRYPTION_KEY_VERSION ?? 1)), governance = String(process.env.TREESEED_CAPACITY_GOVERNANCE_SECRET ?? '');
		let capacityCount = 0;
		if (capacitySecret && governance) {
			const codec = new CapacitySecretCodec(governance, capacitySecret, capacityVersion, historical), rows = await client.query<{ id: string; encrypted_reveal_value: string }>("SELECT id,encrypted_reveal_value FROM team_capacity_registration_keys WHERE (encrypted_reveal_value::jsonb->>'keyVersion')::int<>$1 ORDER BY id LIMIT $2 FOR UPDATE SKIP LOCKED", [capacityVersion, limit]);
			for (const row of rows.rows) { await client.query('UPDATE team_capacity_registration_keys SET encrypted_reveal_value=$1 WHERE id=$2', [codec.rewrap(row.encrypted_reveal_value), row.id]); capacityCount += 1; }
		}
		await client.query('COMMIT'); return traces.rowCount! + capacityCount;
	} catch (error) { await client.query('ROLLBACK'); throw error; }
}

export async function main() {
	const databaseUrl = process.env.TREESEED_DATABASE_URL; if (!databaseUrl) throw new Error('TREESEED_DATABASE_URL is required.');
	const pool = new Pool({ connectionString: databaseUrl, max: 2 }); const client = await pool.connect(); let count = 0;
	try {
		for (;;) { const changed = await batch(client, 100); count += changed; if (!changed) break; process.stdout.write(`Encrypted ${count} protected diagnostic payloads.\n`); }
		if (process.env.TREESEED_REWRAP_ENVELOPES === 'true') for (;;) { const changed = await rewrapBatch(client, 100); count += changed; if (!changed) break; process.stdout.write(`Rewrapped ${count} protected envelopes.\n`); }
		await client.query('ALTER TABLE communication_execution_trace_events VALIDATE CONSTRAINT communication_trace_no_new_protected_plaintext');
		process.stdout.write(`Diagnostic encryption backfill complete (${count} rows); plaintext constraint validated.\n`);
	} finally { client.release(); await pool.end(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
