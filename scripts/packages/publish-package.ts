import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const packageJson = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8')) as { private?: boolean };
const extraArgs = process.argv.slice(2);
const tagName = process.env.GITHUB_REF_NAME;

if (packageJson.private) {
	console.log('@treeseed/api is private; release:publish is a no-op.');
	process.exit(0);
}

if (tagName && !/^\d+\.\d+\.\d+$/.test(tagName)) {
	console.error(`Refusing to publish @treeseed/api from non-stable tag "${tagName}".`);
	process.exit(1);
}

const npmArgs = ['publish', '.', '--access', 'public'];
if (process.env.GITHUB_ACTIONS === 'true') npmArgs.push('--provenance');
npmArgs.push(...extraArgs);

const result = spawnSync('npm', npmArgs, {
	cwd: packageRoot,
	encoding: 'utf8',
	env: process.env,
});

if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);

if (result.error) {
	console.error(result.error.message);
	process.exit(1);
}

process.exit(result.status ?? 1);
