import { createHash } from 'node:crypto';
import { readOsCredentialFile } from '@treeseed/deployment/security/custody';
const keyText=(file:string)=>{const key=readOsCredentialFile(file);try{return key.toString('utf8').trim();}finally{key.fill(0);}};
import { EncryptedEnvelopeCodec, StaticEnvelopeKeyProvider, type EncryptedEnvelopeAad } from '@treeseed/sdk/security';

export interface DiagnosticEnvelopeService {
	encrypt(value: Record<string, unknown>, aad: Omit<EncryptedEnvelopeAad, 'purpose' | 'resourceType' | 'schemaVersion'>): Record<string, unknown>;
	decrypt(value: Record<string, unknown>): Record<string, unknown>;
	rewrap(value: Record<string, unknown>): Record<string, unknown>;
}

function keyMaterial(value: string, label: string) { if (value.length < 24) throw new Error(`${label} must contain at least 24 characters.`); return createHash('sha256').update(`treeseed-diagnostics-kek:${value}`).digest(); }

export function createDiagnosticEnvelopeService(config: Record<string, unknown> = process.env): DiagnosticEnvelopeService {
	const file = String(config.diagnosticsEncryptionKeyFile ?? config.TREESEED_DIAGNOSTICS_ENCRYPTION_KEY_FILE ?? process.env.TREESEED_DIAGNOSTICS_ENCRYPTION_KEY_FILE ?? '');
	if (!file) throw new Error('An OS-custodied diagnostics key file is required.');
	const material = keyText(file);
	const version = Math.max(1, Number(config.TREESEED_DIAGNOSTICS_KEY_VERSION ?? process.env.TREESEED_DIAGNOSTICS_KEY_VERSION ?? 1));
	const historicalFiles = String(config.diagnosticsHistoricalKeyFiles ?? config.TREESEED_DIAGNOSTICS_HISTORICAL_KEY_FILES ?? process.env.TREESEED_DIAGNOSTICS_HISTORICAL_KEY_FILES ?? '');
	const historical = historicalFiles.split(',').map((entry) => entry.trim()).filter(Boolean).map((entry) => {
		const match = /^(\d+):(.+)$/u.exec(entry); if (!match) throw new Error('Historical diagnostics keys must use VERSION:/absolute/path entries.');
		return { id: 'diagnostics', version: Number(match[1]), key: keyMaterial(keyText(match[2]!), `Historical diagnostics key ${match[1]}`) };
	});
	const codec = new EncryptedEnvelopeCodec(new StaticEnvelopeKeyProvider('systemd-credential', { id: 'diagnostics', version, key: keyMaterial(material, 'Diagnostics encryption key') }, historical));
	return {
		encrypt(value, aad) { return codec.encrypt(JSON.stringify(value), { purpose: 'diagnostics', resourceType: 'communication-trace', schemaVersion: 'treeseed.communication-trace/v1', ...aad }); },
		decrypt(value) { return JSON.parse(codec.decrypt(value as never).toString('utf8')) as Record<string, unknown>; },
		rewrap(value) { return codec.rewrap(value as never); },
	};
}
