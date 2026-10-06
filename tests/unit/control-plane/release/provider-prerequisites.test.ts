import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { parse } from 'yaml';
import { expect, it } from 'vitest';
import ts from 'typescript';

function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Original workflow object required');
	return value as Record<string, unknown>;
}

it('capacity candidate source delivery reuses the same complete native verification authority before sealing declared artifacts', () => {
	const source = readFileSync('.github/workflows/publish.yml'), verifySource = readFileSync('.github/workflows/verify.yml');
	const publishing = object(parse(source.toString('utf8'))), verify = object(parse(verifySource.toString('utf8')));
	const candidate = object(object(publishing.jobs)['candidate-source']);
	expect(candidate.uses).toBe('./.github/workflows/verify.yml');
	expect(candidate.secrets).toBe('inherit'); expect(candidate).not.toHaveProperty('steps'); expect(candidate).not.toHaveProperty('services');
	expect(object(verify.on)).toHaveProperty('workflow_call');
	const job = object(object(verify.jobs).verify); if (!Array.isArray(job.steps)) throw new Error('Original complete Verify steps required');
	const steps = job.steps.map(object), download = steps.find(step => step.run === './scripts/build/hydrate-exact-sdk.sh artifacts/sealed-sdk download');
	const tests = steps.find(step => step.run === 'npm run verify:direct');
	const scene = steps.find(step => typeof step.uses === 'string' && step.uses.includes('/run-scenes@'));
	const pack = steps.find(step => step.name === 'Pack verified artifact');
	const upload = steps.find(step => object(step.with ?? {}).name === 'api-source-${{ github.sha }}');
	expect(tests).toBeDefined(); expect(scene).toBeDefined(); expect(pack).toBeDefined();
	expect(download).toBeDefined(); expect(steps.indexOf(download!)).toBeLessThan(steps.indexOf(tests!));
	expect(String(pack?.run)).toContain('npm sbom --sbom-format cyclonedx > source-assets/sbom.cdx.json');
	expect(String(pack?.run)).toContain('npm pack --json --ignore-scripts --pack-destination source-assets');
	expect(String(pack?.run).match(/npm pack/gu)).toHaveLength(1);
	expect(object(steps.find(step => object(step.with ?? {}).name === 'api-${{ github.sha }}')?.with).path).toBe('source-assets/*.tgz');
	expect(steps.indexOf(pack!)).toBeGreaterThan(steps.indexOf(tests!));
	expect(upload).toBeDefined(); expect(steps.indexOf(upload!)).toBeGreaterThan(steps.indexOf(scene!));
	expect(String(object(upload?.with).path).trim().split(/\s+/u)).toEqual(['source-assets/', 'artifacts/sealed-sdk/']);
	expect(object(upload?.with)['if-no-files-found']).toBe('error');
	for (const id of ['candidate-build', 'candidate-seal']) expect(String(object(object(publishing.jobs)[id]).needs)).toBe(id === 'candidate-build' ? 'candidate-source' : 'candidate-build');
	expect(readFileSync('.github/workflows/publish.yml')).toEqual(source); expect(readFileSync('.github/workflows/verify.yml')).toEqual(verifySource);
});

it('capacity execution dependency closure selects the sole exact SDK authority for every transitive consumer', () => {
	const bytes = readFileSync('package.json'), lockBytes = readFileSync('package-lock.json');
	const manifest = object(JSON.parse(bytes.toString('utf8'))), lock = object(JSON.parse(lockBytes.toString('utf8')));
	const authority = object(manifest.dependencies)['@treeseed/sdk'];
	expect(authority).toMatch(/^git\+https:\/\/github\.com\/treeseed-ai\/sdk\.git#[a-f0-9]{40}$/u);
	expect(object(manifest.overrides)['@treeseed/sdk']).toBe('$@treeseed/sdk');
	const packages = object(lock.packages), sdk = object(packages['node_modules/@treeseed/sdk']);
	expect(Object.keys(packages).filter(path => path.endsWith('node_modules/@treeseed/sdk'))).toEqual(['node_modules/@treeseed/sdk']);
	expect(object(object(packages['']).dependencies)['@treeseed/sdk']).toBe(authority);
	expect(String(sdk.resolved).split('#')[1]).toBe(String(authority).split('#')[1]);
	expect(readFileSync('scripts/build/hydrate-exact-sdk.sh', 'utf8')).not.toContain('node_modules/@treeseed/deployment/node_modules/@treeseed/sdk');
	const job = object(object(object(parse(readFileSync('.github/workflows/verify.yml', 'utf8'))).jobs).verify);
	if (!Array.isArray(job.steps)) throw new Error('Original verification steps required');
	const installers = job.steps.map(object).filter(step => typeof step.uses === 'string' && step.uses.includes('/install-exact-sdk@'));
	expect(installers).toHaveLength(1);
	expect(String(object(installers[0]?.with).paths).trim().split(/\s+/u)).toEqual(['node_modules/@treeseed/sdk']);
	expect(object(installers[0]?.env).NODE_ENV).toBe('production');
	const prune = job.steps.map(object).find(step => step.run === 'npm prune --ignore-scripts --no-audit --no-fund --workspaces=false');
	expect(prune).toBeDefined();
	expect(job.steps.indexOf(prune)).toBeGreaterThan(job.steps.indexOf(installers[0]));
	expect(job.steps.indexOf(prune)).toBeLessThan(job.steps.findIndex(step => object(step).run === 'npm run verify:direct'));
	expect(readFileSync('package.json')).toEqual(bytes); expect(readFileSync('package-lock.json')).toEqual(lockBytes);
});

it('native capacity candidate hydration preserves exact SDK bytes and admits only a complete valid dependency tree and SBOM', () => {
	const root = mkdtempSync(resolve(tmpdir(), 'api-capacity-sdk-closure-'));
	const inputs = new Map(['package.json', 'package-lock.json', 'scripts/build/hydrate-exact-sdk.sh', '.github/workflows/verify.yml'].map(path => [path, readFileSync(path)]));
	const sdkBytes = readFileSync('node_modules/@treeseed/sdk/package.json');
	const run = (command: string, args: string[], cwd = root, env: NodeJS.ProcessEnv = process.env) => spawnSync(command, args,
		{ cwd, env, encoding: 'utf8', timeout: 15_000, maxBuffer: 8 * 1024 * 1024 });
	const requireSuccess = (result: ReturnType<typeof run>) => {
		expect(result.error).toBeUndefined(); expect(result.signal).toBeNull(); expect(result.status, result.stdout + result.stderr).toBe(0);
	};
	try {
		requireSuccess(run('npm', ['ls', '--all', '--omit=dev', '--json'], process.cwd()));
		mkdirSync(resolve(root, 'artifacts/sealed-sdk'), { recursive: true });
		for (const [path, bytes] of inputs) { mkdirSync(resolve(root, path, '..'), { recursive: true }); writeFileSync(resolve(root, path), bytes); }
		const pack = run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', resolve(root, 'artifacts/sealed-sdk'), './node_modules/@treeseed/sdk'], process.cwd());
		requireSuccess(pack);
		const inventory: unknown = JSON.parse(pack.stdout);
		if (!Array.isArray(inventory) || inventory.length !== 1) throw new Error('One actual held SDK package required');
		const packed = object(inventory[0]);
		expect(packed.name).toBe('@treeseed/sdk'); expect(packed.version).toBe(object(JSON.parse(sdkBytes.toString('utf8'))).version);
		if (typeof packed.filename !== 'string') throw new Error('Actual packed SDK filename required');
		const archive = resolve(root, 'artifacts/sealed-sdk', packed.filename), archiveBytes = readFileSync(archive);
		requireSuccess(run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--workspaces=false']));
		const hydrated = run('bash', ['scripts/build/hydrate-exact-sdk.sh', 'artifacts/sealed-sdk', 'install']);
		requireSuccess(hydrated);
		// Exercise real SDK-prefix installation residue, then the same owning CI cleanup.
		const installArgs = ['install', '--prefix', 'node_modules/@treeseed/sdk', '--ignore-scripts', '--no-save', '--package-lock=false', '--no-audit', '--no-fund'];
		requireSuccess(run('npm', installArgs, root, { ...process.env, NODE_ENV: 'development' }));
		const polluted = run('npm', ['ls', '--all', '--omit=dev', '--json']);
		expect(polluted.error).toBeUndefined(); expect(polluted.signal).toBeNull(); expect(polluted.status).toBe(1);
		expect(polluted.stdout + polluted.stderr).toContain('extraneous:');
		const workflow = object(object(object(parse(readFileSync('.github/workflows/verify.yml', 'utf8'))).jobs).verify);
		if (!Array.isArray(workflow.steps)) throw new Error('Original verification cleanup required');
		const installer = workflow.steps.map(object).find(step => typeof step.uses === 'string' && step.uses.includes('/install-exact-sdk@'));
		const nodeEnv = object(installer?.env).NODE_ENV;
		expect(nodeEnv).toBe('production'); if (typeof nodeEnv !== 'string') throw new Error('Original SDK installation environment required');
		requireSuccess(run('npm', installArgs, root, { ...process.env, NODE_ENV: nodeEnv }));
		const prune = workflow.steps.map(object).find(step => step.run === 'npm prune --ignore-scripts --no-audit --no-fund --workspaces=false');
		if (typeof prune?.run !== 'string') throw new Error('Original owning dependency cleanup required');
		requireSuccess(run('bash', ['-euo', 'pipefail', '-c', prune.run]));
		const tree = run('npm', ['ls', '--all', '--omit=dev', '--json']); requireSuccess(tree);
		const publicEntry = createRequire(resolve(root, 'package.json')).resolve('@treeseed/sdk/agent-capacity');
		for (const consumer of ['node_modules/@treeseed/deployment/package.json', 'node_modules/@treeseed/identity/package.json', 'node_modules/@treeseed/deployment/node_modules/@treeseed/identity/package.json']) {
			expect(createRequire(resolve(root, consumer)).resolve('@treeseed/sdk/agent-capacity')).toBe(publicEntry);
		}
		const sbom = run('npm', ['sbom', '--omit=dev', '--sbom-format', 'cyclonedx']); requireSuccess(sbom);
		expect(polluted.status).toBe(1); expect(polluted.stdout + polluted.stderr).toContain('extraneous:');
		const document = object(JSON.parse(sbom.stdout));
		if (!Array.isArray(document.components)) throw new Error('Actual nonempty dependency SBOM required');
		expect(document.components.length).toBeGreaterThan(0);
		const sdks = document.components.map(object).filter(component => component.name === '@treeseed/sdk' || component.name === 'sdk' && component.group === '@treeseed');
		expect(sdks).toHaveLength(1); expect(sdks[0]?.version).toBe(packed.version);
		expect(readFileSync(resolve(root, 'node_modules/@treeseed/sdk/package.json'))).toEqual(sdkBytes);
		expect(readFileSync(archive)).toEqual(archiveBytes);
		for (const [path, bytes] of inputs) { expect(readFileSync(path)).toEqual(bytes); expect(readFileSync(resolve(root, path))).toEqual(bytes); }
		expect(readFileSync('node_modules/@treeseed/sdk/package.json')).toEqual(sdkBytes);
	} finally { rmSync(root, { recursive: true, force: true }); expect(existsSync(root)).toBe(false); }
});

it('every capacity execution component step explicitly requires passed evidence from its original verifier', () => {
	const source = readFileSync('guarantees/agent/golden/scenes/component-boundaries.scene.yaml');
	const scene = object(parse(source.toString('utf8')));
	expect(scene.scope).toBe('local-component-tests');
	if (!Array.isArray(scene.workflow)) throw new Error('Original capacity execution workflow required');
	expect(scene.workflow.length).toBeGreaterThan(0);
	for (const value of scene.workflow) {
		const step = object(value);
		expect(step.expect, String(step.id)).toEqual({ status: 'passed' });
	}
	expect(readFileSync('guarantees/agent/golden/scenes/component-boundaries.scene.yaml')).toEqual(source);
});

it('provider compiler preflights strict diagnostics before replacing held outputs instead of accepting transpile-only declarations', () => {
	const source = ts.createSourceFile('build-dist.ts', readFileSync('scripts/build/build-dist.ts', 'utf8'), ts.ScriptTarget.Latest, true);
	const declarations = source.statements.find((value): value is ts.FunctionDeclaration => ts.isFunctionDeclaration(value) && value.name?.text === 'emitDeclarations');
	expect(declarations).toBeDefined();
	const text = declarations?.getText(source);
	expect(text).toContain('strict: true'); expect(text).toContain('noEmitOnError: true'); expect(text).toContain('noCheck: false');
	expect(text).toContain('ts.getPreEmitDiagnostics(program)');
	const invocations = source.statements.map(value => value.getText(source));
	const preflight = invocations.findIndex(value => value === 'const emit = emitDeclarations();');
	const removal = invocations.findIndex(value => value.startsWith('rmSync(distRoot'));
	expect(preflight).toBeGreaterThan(-1); expect(removal).toBeGreaterThan(preflight);
});

it('native original provider compiler denies invalid typed inputs without replacing candidate bytes and admits only a valid controlled retry', () => {
	const root = mkdtempSync(resolve(tmpdir(), 'api-provider-compiler-')), heldBuilder = readFileSync('scripts/build/build-dist.ts');
	const outcomes: Array<{ status: number | null; signal: NodeJS.Signals | null; error: Error | undefined; output: string; retained: boolean }> = [];
	try {
		for (const [index, invalid] of ['export const value: number = "invalid";\n', 'export const value = (input) => input;\n'].entries()) {
			const candidate = resolve(root, String(index)); mkdirSync(resolve(candidate, 'scripts/build'), { recursive: true });
			mkdirSync(resolve(candidate, 'scripts/packages'), { recursive: true });
			cpSync('scripts/build/build-dist.ts', resolve(candidate, 'scripts/build/build-dist.ts'));
			cpSync('scripts/packages/package-tools.ts', resolve(candidate, 'scripts/packages/package-tools.ts'));
			symlinkSync(resolve('node_modules'), resolve(candidate, 'node_modules'), 'dir');
			writeFileSync(resolve(candidate, 'package.json'), '{"type":"module"}');
			writeFileSync(resolve(candidate, 'tsconfig.dist.json'), JSON.stringify({ compilerOptions: { strict: false, target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', types: [] }, include: ['src/**/*.ts'] }));
			for (const path of ['src/api/support/server.ts', 'src/operations-runner/entrypoint.ts', 'src/standards/verifiers/identity-team-live.ts', 'scripts/support/migrate-db.ts']) {
				mkdirSync(resolve(candidate, path, '..'), { recursive: true }); writeFileSync(resolve(candidate, path), 'export const original = true;\n');
			}
			const input = resolve(candidate, 'src/invalid.ts'); writeFileSync(input, invalid);
			mkdirSync(resolve(candidate, 'dist')); const marker = resolve(candidate, 'dist/original-candidate'); writeFileSync(marker, 'original-held-bytes\n');
			const run = () => spawnSync(process.execPath, ['--import', 'tsx', 'scripts/build/build-dist.ts'], { cwd: candidate, env: process.env, encoding: 'utf8', timeout: 15_000 });
			const denied = run();
			let retained = false; try { retained = readFileSync(marker, 'utf8') === 'original-held-bytes\n'; } catch { /* Captured missing candidate is a required denial failure. */ }
			outcomes.push({ status: denied.status, signal: denied.signal, error: denied.error, output: denied.stdout + denied.stderr, retained });
			expect(readFileSync(input, 'utf8')).toBe(invalid); expect(readFileSync(resolve(candidate, 'scripts/build/build-dist.ts'))).toEqual(heldBuilder);
			writeFileSync(input, 'export const value: number = 1;\n'); const retry = run();
			expect(retry.error).toBeUndefined(); expect(retry.signal).toBeNull(); expect(retry.status, retry.stdout + retry.stderr).toBe(0);
			expect(readFileSync(resolve(candidate, 'dist/invalid.js'), 'utf8')).toContain('value = 1');
			expect(readFileSync(resolve(candidate, 'dist/invalid.d.ts'), 'utf8')).toContain('value: number');
			expect(readFileSync(input, 'utf8')).toBe('export const value: number = 1;\n');
		}
		expect(outcomes).toHaveLength(2);
		for (const outcome of outcomes) {
			expect(outcome.error).toBeUndefined(); expect(outcome.signal).toBeNull(); expect(outcome.status).toBe(1); expect(outcome.retained).toBe(true);
		}
		expect(outcomes[0]?.output).toContain('TS2322'); expect(outcomes[1]?.output).toContain('TS7006');
		expect(readFileSync('scripts/build/build-dist.ts')).toEqual(heldBuilder);
	} finally { rmSync(root, { recursive: true, force: true }); }
}, 30_000);

it('complete provider verification inherits the existing disposable PostgreSQL authority before any native suite or coded scene without a second database binding', () => {
	const workflow = object(parse(readFileSync('.github/workflows/verify.yml', 'utf8')));
	const job = object(object(workflow.jobs).verify), service = object(object(job.services).postgres);
	const binding = object(job.env).TREESEED_TEST_POSTGRES_URL;
	expect(typeof binding).toBe('string');
	if (typeof binding !== 'string') throw new Error('Full provider suite needs original disposable database binding');
	const url = new URL(binding);
	expect({ protocol: url.protocol, hostname: url.hostname, port: url.port, username: url.username, pathname: url.pathname,
		password: decodeURIComponent(url.password), search: url.search, hash: url.hash }).toEqual({
		protocol: 'postgres:', hostname: '127.0.0.1', port: '5432', username: 'postgres', pathname: '/postgres',
		password: object(service.env).POSTGRES_PASSWORD, search: '', hash: '',
	});
	expect(service.ports).toEqual(['5432:5432']);
	if (!Array.isArray(job.steps)) throw new Error('Complete original verification steps required');
	const steps = job.steps.map(object);
	expect(steps.filter(step => step.run === 'npm run verify:direct')).toHaveLength(1);
	expect(steps.some(step => typeof step.uses === 'string' && step.uses.includes('/run-scenes@'))).toBe(true);
	for (const step of steps) if (step.env) expect(object(step.env)).not.toHaveProperty('TREESEED_TEST_POSTGRES_URL');
});

it('complete provider suites provision the exact native TreeDX engine and original signed bootstrap before verification and retain explicit cleanup after scenes', () => {
	const workflow = object(parse(readFileSync('.github/workflows/verify.yml', 'utf8')));
	const job = object(object(workflow.jobs).verify);
	if (!Array.isArray(job.steps)) throw new Error('Complete original verification steps required');
	const steps = job.steps.map(object), checkout = steps.find(step => step.name === 'Checkout exact native TreeDX');
	expect(checkout?.uses).toBe('actions/checkout@v4');
	expect(object(checkout?.with)).toEqual({ repository: 'treeseed-ai/treedx',
		ref: '7e9a896df4040051464d312ea0de96b098b922f5', path: '.treeseed/tools/treedx' });
	const start = steps.find(step => step.run === 'node --import tsx scripts/verification/native-treedx.ts start');
	const stop = steps.find(step => step.run === 'node --import tsx scripts/verification/native-treedx.ts stop');
	const verify = steps.find(step => step.run === 'npm run verify:direct');
	const scene = steps.find(step => typeof step.uses === 'string' && step.uses.includes('/run-scenes@'));
	expect(start).toBeDefined(); expect(stop?.if).toBe('always()');
	expect(steps.indexOf(start!)).toBeLessThan(steps.indexOf(verify!));
	expect(steps.indexOf(verify!)).toBeLessThan(steps.indexOf(scene!));
	expect(steps.indexOf(scene!)).toBeLessThan(steps.indexOf(stop!));
	const source = readFileSync('scripts/verification/native-treedx.ts', 'utf8');
	expect(source).toContain("getIn(['jobs', 'verify', 'steps'], true)");
	expect(source).toContain("checkout.getIn(['with', 'ref'])");
	expect(source).not.toMatch(/const engineCommit = ['"][a-f0-9]{40}['"]/u);
	expect(source).toContain('new TreeDxDelegationAuthority(');
	expect(source).toContain("TREESEED_TREEDX_AUTH_VERIFIER: 'jwks_oidc'");
	expect(source).toContain("['phx.server', '--no-compile', '--no-deps-check']");
	expect(source).not.toContain('auth/dev-token');
	expect(source).not.toContain('rejectUnauthorized: false');
});
