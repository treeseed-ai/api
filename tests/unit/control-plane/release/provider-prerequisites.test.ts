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
