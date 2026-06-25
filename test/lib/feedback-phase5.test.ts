import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function source(path: string) {
	return readFileSync(path, 'utf8');
}

describe('Phase 5 feedback API contract', () => {
	it('declares a narrow feedback endpoint with validation, audit, and triage behavior', () => {
		const app = source('src/api/app.ts');
		const routeStart = app.indexOf("app.post('/v1/feedback'");
		const routeEnd = app.indexOf("app.post('/v1/auth/device/start'", routeStart);
		expect(routeStart).toBeGreaterThan(-1);
		expect(routeEnd).toBeGreaterThan(routeStart);
		const feedbackRoute = app.slice(routeStart, routeEnd);

		expect(app).toContain("app.post('/v1/feedback'");
		expect(app).toContain('FEEDBACK_TYPES');
		expect(app).toContain('FEEDBACK_SCREENSHOT_TYPES');
		expect(app).toContain('MAX_FEEDBACK_SCREENSHOT_BYTES');
		expect(app).toContain('validateFeedbackAccess');
		expect(app).toContain("eventType: 'feedback.submitted'");
		expect(app).toContain("kind: 'feedback'");
		expect(feedbackRoute).toContain("c.header('cache-control', 'no-store')");
		expect(feedbackRoute).not.toMatch(/rawR2Url|objectKey|privateObjectUrl|dataUrl: screenshot/iu);
	});

	it('classifies feedback as public while preserving private-context access checks', () => {
		const descriptors = source('src/api/route-descriptors.ts');
		const acceptance = source('scripts/api-acceptance.ts');

		expect(descriptors).toContain("if (path === '/v1/feedback') return 'public'");
		expect(descriptors).toContain("if (path === '/v1/feedback') return ACCEPTANCE_ACTORS");
		expect(descriptors).toContain("if (path === '/v1/feedback') return 'feedback'");
		expect(acceptance).toContain('feedback: {');
		expect(acceptance).toContain("type: 'bug'");
	});
});
