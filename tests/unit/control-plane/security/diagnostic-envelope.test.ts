import { keyFixture } from './os-key-fixture.ts';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDiagnosticEnvelopeService } from '../../../../src/security/diagnostic-envelope.ts';

const aad = { teamId: 'team-1', topicId: 'topic-1', sendId: 'send-1', invocationId: 'invocation-1', assignmentId: 'assignment-1', sequence: 3, eventType: 'tool.completed', resourceId: 'trace-1' };

describe('protected diagnostic envelopes', () => {
	it('authenticates full correlation and rejects row substitution', () => {
		const service = createDiagnosticEnvelopeService({ environment: 'test', TREESEED_DIAGNOSTICS_ENCRYPTION_KEY_FILE: keyFixture('diagnostic-test-key-material-generation-one'), TREESEED_DIAGNOSTICS_KEY_VERSION: 1 });
		const envelope = service.encrypt({ tool: 'read', result: 'ok' }, aad);
		expect(service.decrypt(envelope)).toEqual({ tool: 'read', result: 'ok' });
		expect(() => service.decrypt({ ...envelope, aad: { ...(envelope.aad as Record<string, unknown>), assignmentId: 'assignment-2' } })).toThrow();
	});

	it('rewraps only the DEK under an active generation while preserving payload ciphertext', () => {
		const old = createDiagnosticEnvelopeService({ environment: 'test', TREESEED_DIAGNOSTICS_ENCRYPTION_KEY_FILE: keyFixture('diagnostic-test-key-material-generation-one'), TREESEED_DIAGNOSTICS_KEY_VERSION: 1 });
		const envelope = old.encrypt({ protected: true }, aad), root = mkdtempSync(resolve(tmpdir(), 'treeseed-diagnostic-keys-')), prior = resolve(root, 'v1.key');
		writeFileSync(prior, 'diagnostic-test-key-material-generation-one', {mode:0o600});
		const next = createDiagnosticEnvelopeService({ environment: 'test', TREESEED_DIAGNOSTICS_ENCRYPTION_KEY_FILE: keyFixture('diagnostic-test-key-material-generation-two'), TREESEED_DIAGNOSTICS_KEY_VERSION: 2, TREESEED_DIAGNOSTICS_HISTORICAL_KEY_FILES: `1:${prior}` });
		const rewrapped = next.rewrap(envelope);
		expect(rewrapped.keyVersion).toBe(2); expect(rewrapped.ciphertext).toBe(envelope.ciphertext); expect(next.decrypt(rewrapped)).toEqual({ protected: true });
	});
});
