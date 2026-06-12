import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { packageRoot } from './package-tools.ts';

const textExtensions = new Set(['.js', '.ts', '.mjs', '.cjs', '.d.ts', '.json', '.md']);
const forbiddenPatterns = [
	/['"`]workspace:[^'"`\n]+['"`]/,
	/['"`]file:[^'"`\n]+['"`]/,
	/['"`][^'"`\n]*\/packages\/[^'"`\n]*\/src\/[^'"`\n]*['"`]/,
	/['"`](?:\.\.\/)+(?:sdk|core|agent|cli)\/src\/[^'"`\n]*['"`]/,
];

function run(command: string, args: string[], env: Record<string, string> = {}) {
	const result = spawnSync(command, args, {
		cwd: packageRoot,
		stdio: 'inherit',
		encoding: 'utf8',
		env: {
			...process.env,
			...env,
		},
	});
	if (result.status !== 0) {
		throw new Error(`${command} ${args.join(' ')} failed`);
	}
}

function walkFiles(root: string): string[] {
	if (!existsSync(root)) return [];
	const files: string[] = [];
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		const fullPath = join(root, entry.name);
		if (entry.isDirectory()) files.push(...walkFiles(fullPath));
		else files.push(fullPath);
	}
	return files;
}

function assertNoLocalDependencySpecs() {
	const packageJson = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8')) as Record<string, Record<string, string> | undefined>;
	for (const sectionName of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
		for (const [name, spec] of Object.entries(packageJson[sectionName] ?? {})) {
			if (spec.startsWith('workspace:') || spec.startsWith('file:')) {
				throw new Error(`package.json ${sectionName}.${name} must not use ${spec}.`);
			}
		}
	}

	const lockfilePath = resolve(packageRoot, 'package-lock.json');
	if (!existsSync(lockfilePath)) throw new Error('package-lock.json is required.');
	const lockfile = JSON.parse(readFileSync(lockfilePath, 'utf8')) as {
		packages?: Record<string, { resolved?: string; link?: boolean }>;
	};
	for (const [key, value] of Object.entries(lockfile.packages ?? {})) {
		if (key.startsWith('../') || key.includes('/../')) throw new Error(`package-lock.json contains local package entry: ${key}`);
		if (value.link) throw new Error(`package-lock.json contains linked dependency entry: ${key}`);
		const resolved = value.resolved ?? '';
		if (resolved.startsWith('../') || resolved.startsWith('./') || resolved.startsWith('file:') || resolved.startsWith('workspace:')) {
			throw new Error(`package-lock.json contains local resolution for ${key}: ${resolved}`);
		}
	}
}

function scanDirectory(root: string) {
	for (const filePath of walkFiles(root)) {
		const relativePath = relative(packageRoot, filePath);
		if (relativePath.startsWith('dist/node_modules/')) continue;
		if (!textExtensions.has(extname(filePath))) continue;
		const source = readFileSync(filePath, 'utf8');
		for (const pattern of forbiddenPatterns) {
			if (pattern.test(source)) {
				throw new Error(`${relativePath} contains forbidden reference matching ${pattern}.`);
			}
		}
	}
}

function assertCleanDist() {
	const distRoot = resolve(packageRoot, 'dist');
	if (!existsSync(distRoot)) throw new Error('dist is missing.');
	if (existsSync(resolve(distRoot, 'src'))) throw new Error('dist/src must not exist.');
	for (const filePath of walkFiles(distRoot)) {
		if (filePath.includes('.ts-run-')) throw new Error(`${relative(packageRoot, filePath)} must not exist.`);
		if (filePath.endsWith('.d.js')) throw new Error(`${relative(packageRoot, filePath)} must not exist.`);
	}
	scanDirectory(distRoot);
}

function runAcceptanceIfConfigured() {
	const baseUrl = process.env.TREESEED_API_BASE_URL;
	if (!baseUrl) {
		console.log('Skipping API acceptance tests: TREESEED_API_BASE_URL is not set.');
		return;
	}
	if (!process.env.TREESEED_ACCEPTANCE_SERVICE_ID || !process.env.TREESEED_ACCEPTANCE_SERVICE_SECRET) {
		console.log('Skipping API acceptance tests: TREESEED_ACCEPTANCE_SERVICE_ID and TREESEED_ACCEPTANCE_SERVICE_SECRET are not both set.');
		return;
	}
	run('npm', ['run', 'test:acceptance', '--', '--base-url', baseUrl]);
}

async function smokeImportDist() {
	const app = await import('../dist/api/app.js');
	const server = await import('../dist/api/server.js');
	const store = await import('../dist/api/store.js');
	const pg = await import('../dist/api/market-postgres.js');
	const runner = await import('../dist/operations-runner/entrypoint.js');
	if (typeof app.createApiApp !== 'function') throw new Error('missing createApiApp');
	if (typeof server.createApiServer !== 'function') throw new Error('missing createApiServer');
	if (typeof store.MarketControlPlaneStore !== 'function') throw new Error('missing MarketControlPlaneStore');
	if (typeof pg.createMarketPostgresDatabase !== 'function') throw new Error('missing createMarketPostgresDatabase');
	if (typeof runner.main !== 'function') throw new Error('missing operations runner main');
}

assertNoLocalDependencySpecs();
scanDirectory(resolve(packageRoot, 'src'));
run('npm', ['run', 'lint']);
assertCleanDist();
run('npm', ['run', 'test:unit']);
runAcceptanceIfConfigured();
await smokeImportDist();
