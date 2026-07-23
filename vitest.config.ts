import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		fileParallelism: true,
		maxWorkers: 2,
		include: ['tests/**/*.test.ts'],
		testTimeout: 30_000,
	},
});
