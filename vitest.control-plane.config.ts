import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

const sdkSource = process.env.TREESEED_SDK_SOURCE_ROOT;

export default defineConfig({
	resolve: { alias: sdkSource ? {
		'@treeseed/sdk/agent-capacity': resolve(sdkSource, 'src/capacity/agents/agent-capacity.ts'),
		'@treeseed/sdk/operator-contracts': resolve(sdkSource, 'src/operator-contracts/index.ts'),
	} : {} },
	test: {
		fileParallelism: true,
		maxWorkers: 2,
		include: ['tests/unit/control-plane/**/*.test.ts'],
		testTimeout: 30_000,
	},
});
