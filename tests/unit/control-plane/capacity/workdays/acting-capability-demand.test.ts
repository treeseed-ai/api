import { describe, expect, it } from 'vitest';
import { compileExecutionNodeCapabilityDemand } from '../../../../../src/api/capacity/services/build/execution-node-demand-compiler.ts';

describe('acting capability demand', () => {
	it('freezes required work-unit capabilities against the active ontology', async () => {
		const database = {
			first: async () => ({ generation: 3 }),
			all: async () => [],
		} as never;
		const demand = await compileExecutionNodeCapabilityDemand(database, [
			'treeseed.engineering.code-change',
			'treeseed.engineering.repository-analysis',
			'treeseed.engineering.code-change',
		]);

		expect(demand.requirements.map((entry) => entry.capabilityId)).toEqual([
			'treeseed.engineering.code-change',
			'treeseed.engineering.repository-analysis',
		]);
		expect(demand.resolved.map((entry) => entry.id)).toEqual([
			'treeseed.engineering.code-change',
			'treeseed.engineering.repository-analysis',
		]);
		expect(demand.demandDigest).toMatch(/^sha256:/u);
	});

	it('rejects acting work without a capability contract', async () => {
		await expect(compileExecutionNodeCapabilityDemand({} as never, [])).rejects.toMatchObject({
			code: 'capability_requirements_required',
		});
	});
});
