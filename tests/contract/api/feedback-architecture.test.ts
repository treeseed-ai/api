import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function source(path: string) {
	return readFileSync(path, 'utf8');
}

describe('feedback API architecture contract', () => {
	it('declares a narrow feedback endpoint with validation, audit, and triage behavior', () => {
		const feedbackRoute = source('src/api/routes/foundation-health-market-and-feedback.ts');
		const feedbackSupport = source('src/api/app/support/feedback.ts');

		expect(feedbackRoute).toContain("app.post('/v1/feedback'");
		expect(feedbackRoute).toContain('FEEDBACK_TYPES');
		expect(feedbackRoute).toContain('FEEDBACK_SCREENSHOT_TYPES');
		expect(feedbackRoute).toContain('MAX_FEEDBACK_SCREENSHOT_BYTES');
		expect(feedbackRoute).toContain('validateFeedbackAccess');
		expect(feedbackSupport).toContain("eventType: 'feedback.submitted'");
		expect(feedbackSupport).toContain("kind: 'feedback'");
		expect(feedbackRoute).toContain("c.header('cache-control', 'no-store')");
		expect(feedbackRoute).not.toMatch(/rawR2Url|objectKey|privateObjectUrl|dataUrl: screenshot/iu);
	});

	it('classifies feedback as public while preserving private-context access checks', () => {
		const descriptors = [
			source('src/api/route-descriptors-support/authorization-policy.ts'),
			source('src/api/route-descriptors-support/request-body-factories.ts'),
		].join('\n');
		const acceptance = source('scripts/api-acceptance-support/request-body-factories.ts');

		expect(descriptors).toMatch(/if \(path === '\/v1\/feedback'\)\s+return 'public'/u);
		expect(descriptors).toMatch(/if \(path === '\/v1\/feedback'\)\s+return ACCEPTANCE_ACTORS/u);
		expect(descriptors).toMatch(/if \(path === '\/v1\/feedback'\)\s+return 'feedback'/u);
		expect(acceptance).toContain('feedback: {');
		expect(acceptance).toContain("type: 'bug'");
	});
});
