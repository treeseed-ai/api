import { expect, it } from 'vitest';
import { executionWorkdayStart } from '../../../../../../acceptance/execution-inventory.ts';
import { executionStartFixture } from './execution-start-fixture.ts';

it('isolated managed API verifier resolves the original retained SDK start without inherited environment mutation or run discovery', () => {
	const f = executionStartFixture();
	try {
		const before = structuredClone(f.environment);
		expect(executionWorkdayStart(f.environment).id).toBe(f.receipt.workdayId);
		expect(f.environment).toEqual(before);
	} finally { f.close(); }
});
