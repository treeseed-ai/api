import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

const d1PersistRoot = process.env.TREESEED_API_D1_LOCAL_PERSIST_TO?.trim()
	|| resolve(mkdtempSync(join(tmpdir(), 'treeseed-api-vitest-')), 'd1');

export default defineConfig({
	test: {
		env: {
			TREESEED_API_D1_LOCAL_PERSIST_TO: d1PersistRoot,
		},
		include: ['test/**/*.test.ts'],
	},
});
