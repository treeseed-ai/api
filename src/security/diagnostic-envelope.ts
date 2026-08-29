import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { EncryptedEnvelopeCodec, StaticEnvelopeKeyProvider, type EncryptedEnvelopeAad } from '@treeseed/sdk/security';

export interface DiagnosticEnvelopeService {
	encrypt(value: Record<string, unknown>, aad: Omit<EncryptedEnvelopeAad, 'purpose' | 'resourceType' | 'schemaVersion'>): Record<string, unknown>;
	decrypt(value: Record<string, unknown>): Record<string, unknown>;
	rewrap(value: Record<string, unknown>): Record<string, unknown>;
}

function keyMaterial(value: string, label: string) { if (value.length < 24) throw new Error(`${label} must contain at least 24 characters.`); return createHash('sha256').update(`treeseed-diagnostics-kek:${value}`).digest(); }

export function createDiagnosticEnvelopeService(config: Record<string, unknown> = process.env): DiagnosticEnvelopeService {
	const environment = String(config.environment ?? config.TREESEED_ENVIRONMENT ?? process.env.TREESEED_ENVIRONMENT ?? 'local');
	const file = String(config.diagnosticsEncryptionKeyFile ?? config.TREESEED_DIAGNOSTICS_ENCRYPTION_KEY_FILE ?? process.env.TREESEED_DIAGNOSTICS_ENCRYPTION_KEY_FILE ?? '');
	const direct = String(config.diagnosticsEncryptionKey ?? config.TREESEED_DIAGNOSTICS_ENCRYPTION_KEY ?? process.env.TREESEED_DIAGNOSTICS_ENCRYPTION_KEY ?? '');
	if (direct && !['local', 'test'].includes(environment)) throw new Error('Production diagnostics encryption keys must use service-vault file custody, not environment values.');
	const source = file ? readFileSync(file, 'utf8').trim() : direct;
	if (!source && !['local', 'test'].includes(environment)) throw new Error('TREESEED_DIAGNOSTICS_ENCRYPTION_KEY is required outside local/test environments.');
	const material = source || 'treeseed-local-diagnostics-encryption-key';
	if (material.length < 24 && !['local', 'test'].includes(environment)) throw new Error('Diagnostics encryption key must contain at least 24 characters.');
	const version = Math.max(1, Number(config.TREESEED_DIAGNOSTICS_KEY_VERSION ?? process.env.TREESEED_DIAGNOSTICS_KEY_VERSION ?? 1));
	const historicalFiles = String(config.diagnosticsHistoricalKeyFiles ?? config.TREESEED_DIAGNOSTICS_HISTORICAL_KEY_FILES ?? process.env.TREESEED_DIAGNOSTICS_HISTORICAL_KEY_FILES ?? '');
	const historical = historicalFiles.split(',').map((entry) => entry.trim()).filter(Boolean).map((entry) => {
		const match = /^(\d+):(.+)$/u.exec(entry); if (!match) throw new Error('Historical diagnostics keys must use VERSION:/absolute/path entries.');
		return { id: 'diagnostics', version: Number(match[1]), key: keyMaterial(readFileSync(match[2]!, 'utf8').trim(), `Historical diagnostics key ${match[1]}`) };
	});
	const codec = new EncryptedEnvelopeCodec(new StaticEnvelopeKeyProvider('systemd-credential', { id: 'diagnostics', version, key: keyMaterial(material, 'Diagnostics encryption key') }, historical));
	return {
		encrypt(value, aad) { return codec.encrypt(JSON.stringify(value), { purpose: 'diagnostics', resourceType: 'communication-trace', schemaVersion: 'treeseed.communication-trace/v1', ...aad }); },
		decrypt(value) { return JSON.parse(codec.decrypt(value as never).toString('utf8')) as Record<string, unknown>; },
		rewrap(value) { return codec.rewrap(value as never); },
	};
}
