import { describe, expect, it } from 'vitest';
import { initializeTemplate } from '../../../../src/api/control-plane/projects/initialize-template.ts';

const base = '/repos/example/app';
const checkpointPath = '.treeseed-template-initialization.json';
const checkpoint = JSON.stringify({ schemaVersion: 'treeseed.template-initialization/v1', templateDigest: 'sha256:accepted' });

function fixture(initial: 'empty' | 'checkpoint' | 'complete' | 'unrelated' = 'empty') {
	const calls: { path: string; method: string; body: any }[] = [];
	let head = initial === 'empty' ? '' : initial === 'complete' ? 'complete' : 'checkpoint';
	let staging = ''; let checkpointBody = initial === 'unrelated' ? 'unrelated' : checkpoint;
	let moveOnCommit = false; let failAfterBootstrap = false;
	const github = async (path: string, init: RequestInit = {}): Promise<Record<string, any> | null> => {
		const method = init.method ?? 'GET'; const body = init.body ? JSON.parse(String(init.body)) : undefined;
		calls.push({ path, method, body });
		if (path === `${base}/git/ref/heads/main`) {
			if (!head) throw Object.assign(new Error('empty'), { code: 'github_repository_empty' });
			return { object: { sha: head } };
		}
		if (method === 'PUT' && path === `${base}/contents/${checkpointPath}`) {
			expect(head).toBe(''); expect(body.branch).toBe('main');
			head = 'checkpoint'; checkpointBody = Buffer.from(body.content, 'base64').toString(); return {};
		}
		if (path === `${base}/git/blobs` && method === 'POST') {
			if (!head) throw new Error('GitHub cannot create blobs in an empty repository');
			if (failAfterBootstrap) throw new Error('interrupted'); return { sha: 'file-blob' };
		}
		if (path === `${base}/git/trees` && method === 'POST') {
			expect(body.tree.map((entry: any) => entry.path)).toEqual(['README.md']); return { sha: 'full-tree' };
		}
		if (path === `${base}/git/commits/checkpoint`) return { tree: { sha: 'checkpoint-tree' }, parents: [] };
		if (path === `${base}/git/commits/complete`) return { tree: { sha: 'full-tree' }, parents: [{ sha: 'checkpoint' }] };
		if (path === `${base}/git/trees/checkpoint-tree`) return { tree: [{ path: checkpointPath, type: 'blob', mode: '100644', sha: 'checkpoint-blob' }] };
		if (path === `${base}/git/blobs/checkpoint-blob`) return { encoding: 'base64', content: Buffer.from(checkpointBody).toString('base64') };
		if (path === `${base}/git/commits` && method === 'POST') {
			expect(body.parents).toEqual(['checkpoint']); if (moveOnCommit) head = 'concurrent'; return { sha: 'complete' };
		}
		if (path === `${base}/git/refs/heads/main` && method === 'PATCH') {
			expect(body.force).toBe(false); head = body.sha; return {};
		}
		if (path === `${base}/git/ref/heads/staging`) return staging ? { object: { sha: staging } } : null;
		if (path === `${base}/git/refs` && method === 'POST') { staging = body.sha; return {}; }
		throw new Error(`Unexpected ${method} ${path}`);
	};
	return { calls, github, interrupt: () => { failAfterBootstrap = true; }, resume: () => { failAfterBootstrap = false; },
		move: () => { moveOnCommit = true; }, setStaging: (value: string) => { staging = value; } };
}

const run = (state: ReturnType<typeof fixture>) => initializeTemplate({ github: state.github, base,
	files: new Map([['README.md', Buffer.from('accepted template')]]), templateDigest: 'sha256:accepted', message: 'Initialize app' });

describe('empty repository template initialization', () => {
	it('initializes through Contents before Git database writes, then fast-forwards', async () => {
		const state = fixture(); await expect(run(state)).resolves.toBe('complete');
		expect(state.calls.findIndex((call) => call.method === 'PUT')).toBeLessThan(state.calls.findIndex((call) => call.path.endsWith('/git/blobs')));
		expect(state.calls.filter((call) => call.method === 'PATCH')).toHaveLength(1);
	});
	it('resumes an interrupted exact checkpoint without creating another initial commit', async () => {
		const state = fixture(); state.interrupt(); await expect(run(state)).rejects.toThrow('interrupted');
		state.resume(); await expect(run(state)).resolves.toBe('complete');
		expect(state.calls.filter((call) => call.method === 'PUT')).toHaveLength(1);
	});
	it('replays the complete template without writing commits or moving refs', async () => {
		const state = fixture('complete'); state.setStaging('complete'); await expect(run(state)).resolves.toBe('complete');
		expect(state.calls.some((call) => call.method === 'PATCH' || call.method === 'PUT' || (call.method === 'POST' && !['/git/blobs', '/git/trees'].some((suffix) => call.path.endsWith(suffix))))).toBe(false);
	});
	it('refuses to overwrite unrecognized checkpoint content', async () => {
		const state = fixture('unrelated'); await expect(run(state)).rejects.toThrow('does not match');
		expect(state.calls.some((call) => call.method === 'PATCH')).toBe(false);
	});
	it('refuses a concurrent main update', async () => {
		const state = fixture('checkpoint'); state.move(); await expect(run(state)).rejects.toThrow('Main moved');
		expect(state.calls.some((call) => call.method === 'PATCH')).toBe(false);
	});
	it('preserves an independently changed staging branch', async () => {
		const state = fixture('complete'); state.setStaging('unrelated'); await expect(run(state)).rejects.toThrow('staging branch');
	});
	it('does not treat unrelated failures or missing main as permission to initialize', async () => {
		for (const github of [async () => { throw Object.assign(new Error('other conflict'), { status: 409 }); }, async () => null]) {
			await expect(initializeTemplate({ github, base, files: new Map([['README.md', Buffer.from('a')]]), templateDigest: 'digest', message: 'init' })).rejects.toThrow();
		}
	});
});
