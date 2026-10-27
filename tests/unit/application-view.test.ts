import { test, expect } from 'bun:test';
import { PlatformOperations, ServiceSchemas } from '@treeseed-cordis/sdk';
import { ApiApplicationView } from '../../src/application-view.js';
class ApplicationViewTests {
    private readonly publicView = { id: 'app-' + 'a'.repeat(64), phase: 'completed' as const, desiredComposition: 'b'.repeat(64), activeComposition: 'b'.repeat(64), result: 'ready', recovery: null, historyReference: '.cordis/applications/app-' + 'a'.repeat(64) };
    privateRecord(): void { const record = ServiceSchemas.applicationRecord.parse({ ...this.publicView, formatVersion: 3, planId: 'plan-' + 'c'.repeat(64), digest: 'c'.repeat(64), idempotencyKey: 'PRIVATE_APPLICATION_CANARY', requestDigest: 'd'.repeat(64), sequence: 7, expectedComposition: null, resourceSetDigest: 'e'.repeat(64), acknowledgements: [] }), response = ApiApplicationView.project(record); expect(PlatformOperations.get.parseOutput(response)).toEqual(this.publicView); expect(JSON.stringify(response)).not.toContain('PRIVATE_APPLICATION_CANARY'); expect(response).not.toHaveProperty('planId'); expect(response).not.toHaveProperty('acknowledgements'); }
    legacy(): void { expect(ApiApplicationView.project(this.publicView)).toEqual(this.publicView); }
}
const applicationViews = new ApplicationViewTests();
test('unit: private format3 application records become exact public SDK views without bookkeeping', applicationViews.privateRecord.bind(applicationViews));
test('unit: legacy public application views keep their SDK response shape', applicationViews.legacy.bind(applicationViews));
