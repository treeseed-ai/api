import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { DataType, newDb } from 'pg-mem';
import { createApiApp } from '../src/api/app.js';
import { MarketPostgresDatabase } from '../src/api/market-postgres.js';
import { packageRoot } from './package-tools.ts';

const textExtensions = new Set(['.js', '.ts', '.d.ts', '.json', '.md']);
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

async function runAsync(command: string, args: string[], env: Record<string, string> = {}) {
	const child = spawn(command, args, {
		cwd: packageRoot,
		stdio: 'inherit',
		env: {
			...process.env,
			...env,
		},
	});
	const status = await new Promise<number | null>((resolvePromise, rejectPromise) => {
		child.once('error', rejectPromise);
		child.once('exit', (code) => resolvePromise(code));
	});
	if (status !== 0) {
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
		if (filePath.endsWith('.d.js')) throw new Error(`${relative(packageRoot, filePath)} must not exist.`);
	}
	scanDirectory(distRoot);
}

function createAcceptanceDatabase() {
	const memory = newDb();
	memory.public.registerFunction({
		name: 'md5',
		args: [DataType.text],
		returns: DataType.text,
		implementation: (value: string) => `md5:${value}`,
	});
	const pg = memory.adapters.createPg();
	const migrationRoot = existsSync(resolve(packageRoot, '../sdk/drizzle/market'))
		? resolve(packageRoot, '../sdk/drizzle/market')
		: resolve(packageRoot, 'node_modules/@treeseed/sdk/drizzle/market');
	return MarketPostgresDatabase.fromPool(new pg.Pool(), { migrationRoot });
}

function hasRequestBody(method = 'GET') {
	return method !== 'GET' && method !== 'HEAD';
}

async function honoNodeHandler(app: ReturnType<typeof createApiApp>, request: any, response: any) {
	const origin = request.headers.host ? `http://${request.headers.host}` : 'http://127.0.0.1';
	const url = new URL(request.url ?? '/', origin);
	const webRequest = new Request(url, {
		method: request.method,
		headers: request.headers,
		body: hasRequestBody(request.method) ? request : undefined,
		duplex: 'half',
	} as RequestInit & { duplex: 'half' });
	const webResponse = await app.fetch(webRequest);
	response.statusCode = webResponse.status;
	webResponse.headers.forEach((value, key) => response.setHeader(key, value));
	if (!webResponse.body) {
		response.end();
		return;
	}
	Readable.fromWeb(webResponse.body as any).pipe(response);
}

async function startLocalAcceptanceApi() {
	const app = createApiApp({
		db: createAcceptanceDatabase(),
		config: {
			repoRoot: packageRoot,
			authSecret: 'acceptance-local-secret',
			baseUrl: 'http://127.0.0.1:0',
			siteUrl: 'http://127.0.0.1:4321',
			issuer: 'http://127.0.0.1:0',
			environment: 'local',
			projectId: 'treeseed-market',
			projectApiKey: 'market-project-key',
			projectApiPermissions: ['sdk:execute:global', 'agent:execute:global', 'operations:execute:global'],
			platformRunnerSecret: process.env.TREESEED_PLATFORM_RUNNER_SECRET ?? 'acceptance-platform-runner-secret',
			webServiceId: 'web',
			webServiceSecret: 'web-test-secret',
			webAssertionSecret: 'web-assertion-secret',
		},
	});
	const server = createServer((request, response) => {
		void honoNodeHandler(app, request, response).catch((error) => {
			response.statusCode = 500;
			response.end(error instanceof Error ? error.message : String(error));
		});
	});
	await new Promise<void>((resolvePromise) => {
		server.listen(0, '127.0.0.1', () => resolvePromise());
	});
	const address = server.address();
	if (!address || typeof address === 'string') throw new Error('Could not determine local acceptance API address.');
	return {
		baseUrl: `http://127.0.0.1:${address.port}`,
		async close() {
			await new Promise<void>((resolvePromise, rejectPromise) => {
				server.close((error) => (error ? rejectPromise(error) : resolvePromise()));
			});
		},
	};
}

async function runAcceptanceIfConfigured() {
	const baseUrl = process.env.TREESEED_API_BASE_URL;
	if (baseUrl && process.env.TREESEED_ACCEPTANCE_SERVICE_ID && process.env.TREESEED_ACCEPTANCE_SERVICE_SECRET) {
		await runAsync('npm', ['run', 'test:acceptance', '--', '--base-url', baseUrl]);
		return;
	}
	if (baseUrl) {
		console.log('TREESEED_API_BASE_URL is set without acceptance service credentials; using isolated local API acceptance target.');
	}
	console.log('Starting isolated local API acceptance target.');
	const server = await startLocalAcceptanceApi();
	try {
		await runAsync('npm', ['run', 'test:acceptance', '--', '--environment', 'local', '--base-url', server.baseUrl], {
			TREESEED_ACCEPTANCE_SERVICE_ID: process.env.TREESEED_ACCEPTANCE_SERVICE_ID ?? 'web',
			TREESEED_ACCEPTANCE_SERVICE_SECRET: process.env.TREESEED_ACCEPTANCE_SERVICE_SECRET ?? 'web-test-secret',
			TREESEED_ACCEPTANCE_EXPOSE_AUTH_TOKENS: '1',
			TREESEED_ACCEPTANCE_REQUEST_TIMEOUT_MS: process.env.TREESEED_ACCEPTANCE_REQUEST_TIMEOUT_MS ?? '120000',
			TREESEED_ACCEPTANCE_IN_PROCESS: '1',
			TREESEED_ENVIRONMENT: 'local',
			TREESEED_PLATFORM_RUNNER_SECRET: process.env.TREESEED_PLATFORM_RUNNER_SECRET ?? 'acceptance-platform-runner-secret',
			CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN ?? 'acceptance-cloudflare-token',
			CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID ?? 'acceptance-cloudflare-account',
		});
	} finally {
		await server.close();
	}
}

async function smokeImportDist() {
	const app = await import(pathToFileURL(resolve(packageRoot, 'dist/api/app.js')).href);
	const server = await import(pathToFileURL(resolve(packageRoot, 'dist/api/server.js')).href);
	const store = await import(pathToFileURL(resolve(packageRoot, 'dist/api/store.js')).href);
	const pg = await import(pathToFileURL(resolve(packageRoot, 'dist/api/market-postgres.js')).href);
	const runner = await import(pathToFileURL(resolve(packageRoot, 'dist/operations-runner/entrypoint.js')).href);
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
await runAcceptanceIfConfigured();
await smokeImportDist();
