import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { appendFile, mkdtemp, open, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { isMap, isSeq, parseDocument } from 'yaml';
import { TreeDxDelegationAuthority } from '../../src/api/control-plane/treedx/delegation-authority.ts';

// CI-only native fixture provisioning, never a replacement test/scene runner.
// Existing tests require an external native engine trusting the original signer.
const [action, directory] = process.argv.slice(2);
const prefix = join(tmpdir(), 'api-native-treedx-');
const childEnvironment = { ...process.env };
delete childEnvironment.GH_TOKEN; delete childEnvironment.GITHUB_TOKEN;

async function ownedRoot(value: string) {
	const root = await realpath(value);
	assert.ok(root.startsWith(prefix) && root !== prefix);
	return root;
}

async function exportEnvironment(values: Record<string, string>) {
	const target = process.env.GITHUB_ENV;
	assert.ok(target, 'Native CI setup requires the runner environment file');
	for (const [name, value] of Object.entries(values)) {
		assert.match(name, /^[A-Z_]+$/u);
		if (name === 'TREEDX_TOKEN' || name === 'TREESEED_TREEDX_DELEGATION_PRIVATE_KEY') {
			// Runner masking protocol, not credential observations or artifacts.
			for (const line of value.split('\n').filter(Boolean)) process.stdout.write(`::add-mask::${line}\n`);
		}
		const boundary = `NATIVE_ENV_${name}`;
		assert.ok(!value.split('\n').includes(boundary));
		await appendFile(target, `${name}<<${boundary}\n${value}\n${boundary}\n`);
	}
}

async function launch(root: string, name: string, command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
	const log = await open(join(root, `${name}.log`), 'a', 0o600);
	try {
		const child = spawn(command, args, { cwd, env: { ...env, API_NATIVE_TREEDX_ROOT: root },
			detached: true, stdio: ['ignore', log.fd, log.fd] });
		await new Promise<void>((accept, reject) => { child.once('spawn', accept); child.once('error', reject); });
		assert.ok(child.pid && child.pid > 1);
		await writeFile(join(root, `${name}.pid`), String(child.pid)); child.unref();
	} finally { await log.close(); }
}

async function stop(root: string) {
	for (const name of ['engine', 'jwks']) {
		let pid: number;
		try { pid = Number(await readFile(join(root, `${name}.pid`), 'utf8')); }
		catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') continue; throw error; }
		assert.ok(Number.isInteger(pid) && pid > 1);
		try {
			const environment = await readFile(`/proc/${pid}/environ`, 'utf8');
			assert.ok(environment.split('\0').includes(`API_NATIVE_TREEDX_ROOT=${root}`), 'Never signal an unowned process');
			process.kill(-pid, 'SIGTERM');
			const until = Date.now() + 5000;
			while (Date.now() < until) {
				try { process.kill(-pid, 0); } catch { break; }
				await delay(25);
			}
			try { process.kill(-pid, 0); process.kill(-pid, 'SIGKILL'); throw new Error('Native fixture required forced cleanup'); }
			catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error; }
		} catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
	}
	await rm(join(root, 'private.pem'), { force: true });
}

if (action === 'serve-jwks') {
	assert.ok(directory); const root = await ownedRoot(directory);
	const publicBytes = await readFile(join(root, 'jwks.json'));
	const server = createServer((request, response) => {
		if (request.method !== 'GET' || request.url !== '/jwks') { response.writeHead(404).end(); return; }
		response.setHeader('content-type', 'application/json'); response.end(publicBytes);
	});
	await new Promise<void>((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept); });
	const address = server.address(); assert.ok(address && typeof address !== 'string');
	await writeFile(join(root, 'jwks-url'), `http://127.0.0.1:${address.port}/jwks`);
	process.once('SIGTERM', () => { server.closeAllConnections(); server.close(() => process.exit(0)); });
} else if (action === 'start') {
	assert.ok(process.env.GITHUB_ENV && process.env.GITHUB_WORKSPACE, 'CI-only native setup');
	const workspace = await realpath(process.env.GITHUB_WORKSPACE);
	const source = join(workspace, '.treeseed/tools/treedx');
	const steps = parseDocument(await readFile(join(workspace, '.github/workflows/verify.yml'), 'utf8')).getIn(['jobs', 'verify', 'steps'], true);
	assert.ok(isSeq(steps), 'Original native prerequisite workflow required');
	const checkouts = steps.items.filter(value => isMap(value) && value.get('name') === 'Checkout exact native TreeDX');
	assert.equal(checkouts.length, 1);
	const checkout = checkouts[0]; assert.ok(isMap(checkout));
	const engineCommit = checkout.getIn(['with', 'ref']);
	assert.ok(typeof engineCommit === 'string' && /^[a-f0-9]{40}$/u.test(engineCommit), 'Exact native engine commit required');
	assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim(), engineCommit);
	assert.equal(execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: source, encoding: 'utf8' }), '');
	const root = await mkdtemp(prefix); await exportEnvironment({ API_NATIVE_TREEDX_ROOT: root });
	try {
		const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
		await writeFile(join(root, 'private.pem'), privateKey, { mode: 0o600 });
		const authority = new TreeDxDelegationAuthority({ TREESEED_ENVIRONMENT: 'test', TREESEED_TREEDX_DELEGATION_PRIVATE_KEY: privateKey });
		await writeFile(join(root, 'jwks.json'), JSON.stringify(authority.jwks()));
		const canonical = (await readFile(join(source, 'apps/api/lib/treedx/runtime/capabilities.ex'), 'utf8')).match(/@canonical\s*\[([\s\S]*?)\]/u)?.[1];
		assert.ok(canonical); const capabilities = [...canonical.matchAll(/"([^"\n]+)"/gu)].map(match => match[1]!);
		assert.ok(capabilities.length && new Set(capabilities).size === capabilities.length);
		const delegation = { actorId: 'treeseed-api', tenantId: 'treeseed-control-plane', projectId: 'disposable-conformance',
			connectionId: 'disposable-conformance', scope: { repositoryIds: ['*'], capabilities, refs: ['*'], paths: ['**'] } };
		await launch(root, 'jwks', process.execPath, ['--import', 'tsx', fileURLToPath(import.meta.url), 'serve-jwks', root], workspace, childEnvironment);
		let jwksUrl = '';
		for (let attempt = 0; attempt < 100; attempt++) {
			try { jwksUrl = await readFile(join(root, 'jwks-url'), 'utf8'); break; } catch { await delay(50); }
		}
		assert.ok(jwksUrl, 'Native public JWKS server must become ready');
		// Allocate an unused loopback port; startup failure remains fatal.
		const reservation = createServer();
		await new Promise<void>(accept => reservation.listen(0, '127.0.0.1', accept));
		const address = reservation.address(); assert.ok(address && typeof address !== 'string');
		const port = address.port; await new Promise<void>(accept => reservation.close(() => accept()));
		const baseUrl = `http://127.0.0.1:${port}/`;
		await launch(root, 'engine', 'mix', ['phx.server', '--no-compile', '--no-deps-check'], join(source, 'apps/api'), {
			...childEnvironment, MIX_ENV: 'dev', PORT: String(port), PHX_SERVER: 'true', PHX_HOST: '127.0.0.1',
			TREESEED_TREEDX_ENV: 'test', TREESEED_TREEDX_DATA_DIR: join(root, 'data'),
			TREESEED_TREEDX_AUTH_MODE: 'connected', TREESEED_TREEDX_AUTH_VERIFIER: 'jwks_oidc',
			TREESEED_TREEDX_JWT_ISSUER: authority.issuer, TREESEED_TREEDX_JWT_AUDIENCE: authority.audience,
			TREESEED_TREEDX_JWKS_URL: jwksUrl, TREESEED_TREEDX_JWT_ALLOWED_ALGS: 'RS256',
			TREESEED_TREEDX_BOOTSTRAP_TRUST_ACTOR_ID: delegation.actorId, TREESEED_TREEDX_BOOTSTRAP_TRUST_TENANT_ID: delegation.tenantId,
			TREESEED_TREEDX_BOOTSTRAP_TRUST_CAPABILITIES: capabilities.join(','), TREESEED_TREEDX_BOOTSTRAP_TRUST_REPO_IDS: '*',
			TREESEED_TREEDX_BOOTSTRAP_TRUST_REFS: '*', TREESEED_TREEDX_BOOTSTRAP_TRUST_PATHS: '**',
		});
		let ready = false;
		for (let attempt = 0; attempt < 120; attempt++) {
			try { ready = (await fetch(`${baseUrl}api/v1/health`, { signal: AbortSignal.timeout(1000) })).ok; } catch { ready = false; }
			if (ready) break; await delay(500);
		}
		assert.ok(ready, 'Real native TreeDX health never became ready');
		await exportEnvironment({ TREEDX_BASE_URL: baseUrl, TREEDX_TOKEN: authority.mint(delegation).token,
			TREEDX_CONFORMANCE_ALLOW_ADMIN: '1', TREEDX_CONFORMANCE_ALLOW_INTERNAL: '1',
			TREEDX_CONFORMANCE_ALLOW_DESTRUCTIVE: '1', TREEDX_CONFORMANCE_TMP: root, TREEDX_CONFORMANCE_REF: 'refs/heads/main',
			TREESEED_ENVIRONMENT: 'test', TREESEED_TREEDX_DELEGATION_PRIVATE_KEY: privateKey,
			TREESEED_DEVELOPMENT_WORKSPACE_ROOT: join(workspace, '.treeseed/tools/platform') });
	} catch (error) { await stop(root); throw error; }
} else if (action === 'stop') {
	if (process.env.API_NATIVE_TREEDX_ROOT) {
		const root = await ownedRoot(process.env.API_NATIVE_TREEDX_ROOT);
		await stop(root); await rm(root, { recursive: true });
	}
} else throw new Error('Exact native fixture provisioning action required');
