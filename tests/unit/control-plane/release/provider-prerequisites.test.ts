import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { expect, it } from 'vitest';
import ts from 'typescript';

function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Original workflow object required');
	return value as Record<string, unknown>;
}

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
