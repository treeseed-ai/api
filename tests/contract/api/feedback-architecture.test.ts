import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createFeedbackExportFiles, createStoredZip } from '../../../src/api/feedback/export-bundle.ts';
import { parseFeedbackBody, parseScreenshot } from '../../../src/api/feedback/validation.ts';

const source = (path: string) => readFileSync(path, 'utf8');

describe('feedback API architecture contract', () => {
	it('requires authenticated durable submission and metadata-only audit evidence', () => {
		const submission = source('src/api/routes/feedback/submission.ts');
		const administration = source('src/api/routes/feedback/administration.ts');
		const retired = [
			'src/api/routes/support/foundation-health-market-and-feedback.ts',
			'src/api/app/support/feedback.ts',
		];
		for (const path of retired) expect(() => readFileSync(path)).toThrow();
		expect(submission).toContain("c.get('principal')");
		expect(submission).toContain('feedback_submissions');
		expect(submission).toContain('feedback_attachments');
		expect(submission).not.toContain('upsertTeamInboxItem');
		expect(submission).toMatch(/data: \{ feedbackId: id, type: input\.type,[^}]*hasScreenshot/u);
		expect(administration).toContain("principalHasPlatformPermission(principal, 'feedback:read:global')");
		expect(administration).toContain("namespace: 'feedback', operation: 'generate_export'");
	});

	it('normalizes fields without trusting client identity or contact addresses', () => {
		const result = parseFeedbackBody({
			type: 'bug', message: '  Broken control  ', allowContact: true,
			userId: 'spoofed', contactEmail: 'spoofed@example.test',
			context: { canonicalPath: '/app/account', teamId: 'team-1', userId: 'spoofed' },
			client: { viewport: { width: 1200, height: 800, devicePixelRatio: 2 } },
		});
		expect(result).toMatchObject({ value: { type: 'bug', message: 'Broken control', allowContact: true } });
		expect(JSON.stringify(result)).not.toContain('spoofed@example.test');
		expect(JSON.stringify(result)).not.toContain('"userId"');
	});

	it('accepts only digest-matched declared redacted PNG captures', () => {
		const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
		const digest = createHash('sha256').update(bytes).digest('hex');
		const valid = parseScreenshot({ dataUrl: `data:image/png;base64,${bytes.toString('base64')}`, digest, redacted: true, redactionVersion: 'treeseed.feedback-capture/v3', maskedRegionCount: 3 });
		expect(valid).toMatchObject({ value: { width: 1, height: 1, digest, maskedRegionCount: 3 } });
		expect(parseScreenshot({ dataUrl: `data:image/png;base64,${bytes.toString('base64')}`, digest: '0'.repeat(64), redacted: true, redactionVersion: 'treeseed.feedback-capture/v3' })).toMatchObject({ error: expect.stringContaining('digest') });
		expect(parseScreenshot({ dataUrl: `data:image/png;base64,${bytes.toString('base64')}`, digest, redacted: false, redactionVersion: 'treeseed.feedback-capture/v3' })).toMatchObject({ error: expect.stringContaining('redaction') });
	});

	it('builds a privacy manifest and bounded readable ZIP without direct identifiers', () => {
		const files = createFeedbackExportFiles([{ id: 'feedback-1', type: 'bug', status: 'new', message: 'Button failed', submitter_user_id: 'opaque-user', canonical_path: '/app/', client_json: '{}', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' }], { createdAt: '2026-01-01T00:00:00Z', filters: {}, includeScreenshots: false });
		const zip = createStoredZip(files);
		expect(zip.readUInt32LE(0)).toBe(0x04034b50);
		const contents = Buffer.concat(files.map((file) => Buffer.from(file.bytes))).toString('utf8');
		expect(contents).toContain('treeseed.feedback-export/v1');
		expect(contents).toContain('opaque-user');
		expect(contents).not.toContain('spoofed@example.test');
	});

	it('classifies submission as authenticated and administrator routes as platform-only', () => {
		const policy = source('src/api/route-descriptors-support/accounts/authorization-policy.ts');
		expect(policy).toMatch(/path\.startsWith\('\/v1\/admin\/feedback'\)[\s\S]*return 'platform-admin'/u);
		expect(policy).toMatch(/path === '\/v1\/feedback'[\s\S]*return 'user'/u);
		expect(policy).not.toMatch(/path === '\/v1\/feedback'[^\n]*\|\|[^\n]*service-providers/u);
	});
});
