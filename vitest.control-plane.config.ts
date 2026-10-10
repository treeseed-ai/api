import { configDefaults, defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

const sdkSource = process.env.TREESEED_SDK_SOURCE_ROOT;
const owningTests = 'tests/unit/control-plane/**/*.test.ts';
const archiveTests = 'tests/unit/control-plane/release/installed-assets.test.ts';

export default defineConfig({
	resolve: { alias: sdkSource ? {
		'@treeseed/sdk/agent-capacity': resolve(sdkSource, 'src/capacity/agents/agent-capacity.ts'),
		'@treeseed/sdk/operator-contracts': resolve(sdkSource, 'src/operator-contracts/index.ts'),
		'@treeseed/sdk/content-validation': resolve(sdkSource, 'src/content/validation/index.ts'),
	} : {} },
	test: {
		fileParallelism: true,
		maxWorkers: 2,
		testTimeout: 30_000,
		projects: [
			{ extends: true, test: { name: 'archive', include: [archiveTests], fileParallelism: false, sequence: { groupOrder: 1 } } },
			{ extends: true, test: { name: 'control-plane', include: [owningTests], exclude: [...configDefaults.exclude, archiveTests], sequence: { groupOrder: 2 } } },
		],
	},
});
