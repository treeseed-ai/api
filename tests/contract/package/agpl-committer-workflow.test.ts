import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (...args: string[]) => (...values: unknown[]) => Promise<unknown>;
const workflow = YAML.parse(readFileSync(resolve(process.cwd(), '.github/workflows/agpl-committer-authorization.yml'), 'utf8')) as any;
const script = workflow.jobs.authorization.steps[0].with.script as string;

async function evaluate(actor: string, policy: unknown) {
	const failures: string[] = [];
	const reads: Array<Record<string, unknown>> = [];
	const core = {
		setFailed(message: string) { failures.push(message); },
		summary: { addHeading() { return this; }, addRaw() { return this; }, async write() {} },
	};
	const context = {
		payload: { pull_request: { user: { login: actor }, base: { sha: 'base-sha-123' } } },
		repo: { owner: 'treeseed-ai', repo: 'api' },
	};
	const github = { rest: { repos: { async getContent(input: Record<string, unknown>) {
		reads.push(input);
		return { data: { content: Buffer.from(JSON.stringify(policy)).toString('base64'), encoding: 'base64' } };
	} } } };
	await new AsyncFunction('github', 'context', 'core', script)(github, context, core);
	return { failures, reads };
}

describe('AGPL committer workflow', () => {
	const policy = { schemaVersion: 1, repository: 'treeseed-ai/api', approvedGitHubUsernames: ['adrianwebb'] };

	it('accepts the provider login case-insensitively from the exact base policy', async () => {
		const result = await evaluate('AdrianWebb', policy);
		expect(result.failures).toEqual([]);
		expect(result.reads).toEqual([{ owner: 'treeseed-ai', repo: 'api', path: '.github/approved-committers.json', ref: 'base-sha-123' }]);
	});

	it('routes an unlisted login to one-time approval without asking for email', async () => {
		const result = await evaluate('new-contributor', policy);
		expect(result.failures).toHaveLength(1);
		expect(result.failures[0]).toContain('@new-contributor');
		expect(result.failures[0]).toContain('issues/new?template=agpl-committer-approval.yml');
		expect(result.failures[0]).toContain('no email address or per-PR checkbox');
	});

	it('fails closed for a wrong repository binding or duplicate username', async () => {
		expect((await evaluate('adrianwebb', { ...policy, repository: 'treeseed-ai/sdk' })).failures[0]).toContain('invalid schema or repository binding');
		expect((await evaluate('adrianwebb', { ...policy, approvedGitHubUsernames: ['adrianwebb', 'AdrianWebb'] })).failures[0]).toContain('invalid or duplicate GitHub username');
	});
});
