import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createUnifiedChangeset } from '../../../../src/api/knowledge/changesets/unified-diff.ts';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe('exact-byte changeset application', () => {
	const contents = [null, '', 'one', 'one\n', 'one\n\n', '\n', 'one\ntwo', 'one\ntwo\n', 'α\nβ\n', 'one\r\ntwo\r\n'];
	for (const before of contents) for (const after of contents) {
		if (before === null && after === null) continue;
		it(`round trips ${JSON.stringify(before)} -> ${JSON.stringify(after)}`, () => {
			const directory = mkdtempSync(join(tmpdir(), 'treeseed-changeset-bytes-')); directories.push(directory);
			execFileSync('git', ['init', '--quiet', directory]);
			const path = join(directory, 'source.txt');
			if (before !== null) writeFileSync(path, before);
			const patch = createUnifiedChangeset([{ path: 'source.txt', before, after }]);
			if (before === after) expect(patch).toBe('');
			else execFileSync('git', ['apply', '--whitespace=nowarn', '-'], { cwd: directory, input: patch });
			if (after === null) expect(existsSync(path)).toBe(false);
			else expect(readFileSync(path)).toEqual(Buffer.from(after));
		});
	}
	it('retains exact bytes around compact middle-of-file context', () => {
		const directory = mkdtempSync(join(tmpdir(), 'treeseed-changeset-bytes-')); directories.push(directory);
		execFileSync('git', ['init', '--quiet', directory]);
		const before = Array.from({ length: 20 }, (_, index) => `line ${index}`).join('\n');
		const after = before.replace('line 10', 'changed line 10');
		writeFileSync(join(directory, 'source.txt'), before);
		const patch = createUnifiedChangeset([{ path: 'source.txt', before, after }]);
		expect(patch).not.toContain('line 0\n');
		execFileSync('git', ['apply', '--whitespace=nowarn', '-'], { cwd: directory, input: patch });
		expect(readFileSync(join(directory, 'source.txt'), 'utf8')).toBe(after);
	});
});
