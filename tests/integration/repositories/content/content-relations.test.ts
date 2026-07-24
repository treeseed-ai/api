import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
	createDecisionFromProposals,
	createRelatedLocalContentRecord,
} from '../../../../src/api/support/app.js';

let previousCwd: string | null = null;
let tempRoot: string | null = null;

async function useTempProject() {
	previousCwd = process.cwd();
	tempRoot = await mkdtemp(join(tmpdir(), 'treeseed-content-relations-'));
	process.chdir(tempRoot);
	return tempRoot;
}

afterEach(async () => {
	if (previousCwd) process.chdir(previousCwd);
	previousCwd = null;
	if (tempRoot) await rm(tempRoot, { force: true, recursive: true });
	tempRoot = null;
});

async function writeContent(collection: string, slug: string, frontmatter: Record<string, unknown>, body = 'Body') {
	const root = join(process.cwd(), 'src', 'content', collection);
	await import('node:fs/promises').then(({ mkdir }) => mkdir(root, { recursive: true }));
	const yaml = Object.entries(frontmatter)
		.map(([key, value]) => `${key}: ${Array.isArray(value) ? JSON.stringify(value) : JSON.stringify(value)}`)
		.join('\n');
	await writeFile(join(root, `${slug}.mdx`), `---\n${yaml}\n---\n\n${body}\n`, 'utf8');
}

describe('createRelatedLocalContentRecord', () => {
	it('creates a question from an objective and writes reciprocal references once', async () => {
		await useTempProject();
		await writeContent('objectives', 'core', {
			id: 'objective:core',
			title: 'Core Objective',
			description: 'Parent objective',
			status: 'live',
			relatedQuestions: ['existing-question'],
		});
		const first = await createRelatedLocalContentRecord('objectives', 'core', 'questions', {
			title: 'How should related creation work?',
			slug: 'how-should-related-creation-work',
			description: 'Question description',
			status: 'planned',
		});
		expect(first).toMatchObject({
			child: { collection: 'questions', slug: 'how-should-related-creation-work' },
			relation: { parentField: 'relatedQuestions', childField: 'relatedObjectives' },
		});
		const parent = await readFile(join(process.cwd(), 'src/content/objectives/core.mdx'), 'utf8');
		const child = await readFile(join(process.cwd(), 'src/content/questions/how-should-related-creation-work.mdx'), 'utf8');
		expect(parent.match(/how-should-related-creation-work/gu)).toHaveLength(1);
		expect(child).toContain('relatedObjectives:');
		expect(child).toContain('core');
	});

	it('rejects unsupported pairs and slug conflicts without changing the parent', async () => {
		await useTempProject();
		await writeContent('objectives', 'core', {
			id: 'objective:core',
			title: 'Core Objective',
			description: 'Parent objective',
			status: 'live',
			relatedQuestions: [],
		});
		await writeContent('questions', 'existing-question', {
			id: 'question:existing-question',
			title: 'Existing Question',
			description: 'Already here',
			status: 'planned',
			relatedObjectives: [],
		});
		const before = await readFile(join(process.cwd(), 'src/content/objectives/core.mdx'), 'utf8');
		const unsupported = await createRelatedLocalContentRecord('objectives', 'core', 'proposals', {
			title: 'Unsupported proposal',
			slug: 'unsupported-proposal',
			description: 'Nope',
		});
		const conflict = await createRelatedLocalContentRecord('objectives', 'core', 'questions', {
			title: 'Existing Question',
			slug: 'existing-question',
			description: 'Conflict',
		});
		const after = await readFile(join(process.cwd(), 'src/content/objectives/core.mdx'), 'utf8');
		expect(unsupported.error).toContain('Cannot create related');
		expect(conflict.error).toContain('already exists');
		expect(after).toBe(before);
	});
});

describe('createDecisionFromProposals', () => {
	it('creates one decision from multiple proposals and links the proposals back', async () => {
		await useTempProject();
		await writeContent('proposals', 'first-proposal', {
			id: 'proposal:first-proposal',
			title: 'First Proposal',
			description: 'First proposal',
			status: 'planned',
			decision: '',
		});
		await writeContent('proposals', 'second-proposal', {
			id: 'proposal:second-proposal',
			title: 'Second Proposal',
			description: 'Second proposal',
			status: 'planned',
			decision: '',
		});
		const result = await createDecisionFromProposals({
			proposalSlugs: ['first-proposal', 'second-proposal'],
			decisionType: 'request_changes',
			title: 'Request changes on proposal batch',
			reason: 'The proposals need clearer verification evidence.',
		});
		expect(result).toMatchObject({
			decision: { collection: 'decisions', slug: 'request-changes-on-proposal-batch' },
			proposals: [{ slug: 'first-proposal' }, { slug: 'second-proposal' }],
		});
		const decision = await readFile(join(process.cwd(), 'src/content/decisions/request-changes-on-proposal-batch.mdx'), 'utf8');
		const first = await readFile(join(process.cwd(), 'src/content/proposals/first-proposal.mdx'), 'utf8');
		const second = await readFile(join(process.cwd(), 'src/content/proposals/second-proposal.mdx'), 'utf8');
		expect(decision).toContain('decisionType: request_changes');
		expect(decision).toContain('relatedProposals:');
		expect(decision).toContain('first-proposal');
		expect(decision).toContain('second-proposal');
		expect(first).toContain('decision: request-changes-on-proposal-batch');
		expect(second).toContain('decision: request-changes-on-proposal-batch');
	});

	it('rejects missing proposals and duplicate decision slugs without changing proposals', async () => {
		await useTempProject();
		await writeContent('proposals', 'first-proposal', {
			id: 'proposal:first-proposal',
			title: 'First Proposal',
			description: 'First proposal',
			status: 'planned',
			decision: '',
		});
		await writeContent('decisions', 'existing-decision', {
			id: 'decision:existing-decision',
			title: 'Existing Decision',
			description: 'Already recorded',
			status: 'live',
			decisionType: 'approved',
		});
		const before = await readFile(join(process.cwd(), 'src/content/proposals/first-proposal.mdx'), 'utf8');
		const missing = await createDecisionFromProposals({
			proposalSlugs: ['missing-proposal'],
			decisionType: 'approved',
			title: 'Missing proposal verdict',
			reason: 'No proposal exists.',
		});
		const duplicate = await createDecisionFromProposals({
			proposalSlugs: ['first-proposal'],
			decisionType: 'approved',
			title: 'Existing Decision',
			reason: 'This slug already exists.',
		});
		const unsupported = await createDecisionFromProposals({
			proposalSlugs: ['first-proposal'],
			decisionType: 'superseded',
			title: 'Unsupported Verdict',
			reason: 'Superseded is not a proposal verdict action.',
		});
		const after = await readFile(join(process.cwd(), 'src/content/proposals/first-proposal.mdx'), 'utf8');
		expect((missing as { error?: string }).error).toContain('was not found');
		expect((duplicate as { error?: string }).error).toContain('already exists');
		expect((unsupported as { error?: string }).error).toContain('Unsupported proposal verdict');
		expect(after).toBe(before);
	});
});
