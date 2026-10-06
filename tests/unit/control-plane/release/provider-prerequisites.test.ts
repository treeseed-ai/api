import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { expect, it } from 'vitest';

function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Original workflow object required');
	return value as Record<string, unknown>;
}

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
		ref: '29c40be3b106393ab358874c57a3498598108b66', path: '.treeseed/tools/treedx' });
	const start = steps.find(step => step.run === 'node --import tsx scripts/verification/native-treedx.ts start');
	const stop = steps.find(step => step.run === 'node --import tsx scripts/verification/native-treedx.ts stop');
	const verify = steps.find(step => step.run === 'npm run verify:direct');
	const scene = steps.find(step => typeof step.uses === 'string' && step.uses.includes('/run-scenes@'));
	expect(start).toBeDefined(); expect(stop?.if).toBe('always()');
	expect(steps.indexOf(start!)).toBeLessThan(steps.indexOf(verify!));
	expect(steps.indexOf(verify!)).toBeLessThan(steps.indexOf(scene!));
	expect(steps.indexOf(scene!)).toBeLessThan(steps.indexOf(stop!));
	const source = readFileSync('scripts/verification/native-treedx.ts', 'utf8');
	expect(source).toContain('new TreeDxDelegationAuthority(');
	expect(source).toContain("TREESEED_TREEDX_AUTH_VERIFIER: 'jwks_oidc'");
	expect(source).toContain("['phx.server', '--no-compile', '--no-deps-check']");
	expect(source).not.toContain('auth/dev-token');
	expect(source).not.toContain('rejectUnauthorized: false');
});
