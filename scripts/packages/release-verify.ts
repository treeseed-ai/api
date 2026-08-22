import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { packageRoot } from './package-tools.ts';

const textExtensions = new Set(['.js', '.ts', '.d.ts', '.json', '.md']);
const forbiddenSourceReferences = [
	/['"`][^'"`\n]*\/packages\/[^'"`\n]*\/src\/[^'"`\n]*['"`]/,
	/['"`](?:\.\.\/)+(?:sdk|core|agent|cli)\/src\/[^'"`\n]*['"`]/,
];
const removedApiRoutes = [
	'/v1/acceptance/auth/confirm-email',
	'/v1/auth/device/start',
	'/v1/auth/device/poll',
	'/v1/auth/device/approve',
];

function run(command: string, args: string[]) {
	const result = spawnSync(command, args, {
		cwd: packageRoot,
		stdio: 'inherit',
		encoding: 'utf8',
		env: process.env,
	});
	if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed`);
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

function assertPublishedDependencies() {
	const packageJson = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8')) as Record<string, Record<string, string> | undefined>;
	for (const sectionName of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
		for (const [name, spec] of Object.entries(packageJson[sectionName] ?? {})) {
			if (spec.startsWith('workspace:') || spec.startsWith('file:')) {
				throw new Error(`package.json ${sectionName}.${name} must use a published dependency, not ${spec}.`);
			}
		}
	}
	const lockfile = JSON.parse(readFileSync(resolve(packageRoot, 'package-lock.json'), 'utf8')) as {
		packages?: Record<string, { resolved?: string; link?: boolean }>;
	};
	for (const [key, value] of Object.entries(lockfile.packages ?? {})) {
		const resolved = value.resolved ?? '';
		if (key.startsWith('../') || key.includes('/../') || value.link || resolved.startsWith('file:') || resolved.startsWith('workspace:')) {
			throw new Error(`package-lock.json contains a local dependency at ${key || '<root>'}: ${resolved}`);
		}
	}
}

function assertCleanBuild() {
	const distRoot = resolve(packageRoot, 'dist');
	if (!existsSync(distRoot)) throw new Error('dist is missing.');
	if (existsSync(resolve(distRoot, 'src'))) throw new Error('dist/src must not exist.');
	for (const filePath of walkFiles(distRoot)) {
		if (filePath.endsWith('.d.js')) throw new Error(`${relative(packageRoot, filePath)} must not exist.`);
		if (relative(distRoot, filePath).startsWith('node_modules/')) continue;
		if (!textExtensions.has(extname(filePath))) continue;
		const source = readFileSync(filePath, 'utf8');
		for (const route of removedApiRoutes) {
			if (source.includes(route)) throw new Error(`${relative(packageRoot, filePath)} contains removed API route ${route}.`);
		}
		for (const pattern of forbiddenSourceReferences) {
			if (pattern.test(source)) throw new Error(`${relative(packageRoot, filePath)} contains a source-tree dependency.`);
		}
	}
}

async function assertSupportedExecutables() {
	const server = await import(pathToFileURL(resolve(packageRoot, 'dist/api/support/server.js')).href);
	const runner = await import(pathToFileURL(resolve(packageRoot, 'dist/operations-runner/entrypoint.js')).href);
	const migration = await import(pathToFileURL(resolve(packageRoot, 'dist/scripts/support/migrate-db.js')).href);
	if (typeof server.createApiServer !== 'function') throw new Error('API server executable is missing createApiServer.');
	if (typeof runner.main !== 'function') throw new Error('Operations runner executable is missing main.');
	if (typeof migration.main !== 'function') throw new Error('Database migration executable is missing main.');
}

assertPublishedDependencies();
run('npm', ['run', 'build:dist']);
assertCleanBuild();
run('npm', ['run', 'test:control-plane']);
await assertSupportedExecutables();
