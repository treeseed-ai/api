import { createHash } from 'node:crypto';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { validateContentFrontmatter } from '@treeseed/sdk/content-validation';
import { applyTextChangeset } from '../../../../../../src/api/knowledge/changesets/apply-text-changeset.ts';
import { createUnifiedChangeset } from '../../../../../../src/api/knowledge/changesets/unified-diff.ts';
import { completedGraphRefresh, requireIndexedSourceClosure } from '../../../../../../src/operations-runner/knowledge/publication-executor.ts';
import { relationInputs, relationPath } from '../../../capacity/execution/graph/architecture/relations/relation-fixture.ts';
import { noteSource } from './relation-authoring-fixture.ts';

describe('ordinary exact relation authoring authority', () => {
	it('retains an exact unchanged governed content retry without sending an empty native patch or inventing an application receipt', async () => {
		const content = noteSource(), input = { workspace: { workspaceId: 'input-workspace', baseCommitSha: 'a'.repeat(40), baseRef: 'refs/heads/staging' },
			changes: [{ path: relationPath, before: content, after: content }], idempotencyKey: 'same-input-key' };
		const before = structuredClone(input); let calls = 0;
		const result = await applyTextChangeset({ ...input, client: { applyChangeset: async () => { calls += 1; return { applied: true }; } } });
		expect(calls).toBe(0); expect(result).toBeUndefined(); expect(input).toEqual(before);
	});
	it('serializes the canonical Note link through one original changeset with byte exact patch hash base ref and compare and swap authority', async () => {
		const content = noteSource(), workspace = { workspaceId: 'input-workspace', baseCommitSha: 'a'.repeat(40), baseRef: 'refs/heads/staging' };
		const input = { workspace, changes: [{ path: relationPath, before: null, after: content }], idempotencyKey: 'same-input-key' };
		const before = structuredClone(input), calls: Record<string, unknown>[] = [], receipt = { applied: true };
		const result = await applyTextChangeset({ ...input, client: { applyChangeset: async (value: Record<string, unknown>) => { calls.push(value); return receipt; } } });
		const patch = createUnifiedChangeset(input.changes);
		expect(calls).toEqual([{ workspaceId: workspace.workspaceId, contract: 'treedx.changeset/v1', baseCommitSha: workspace.baseCommitSha,
			baseRef: workspace.baseRef, patch, patchSha256: createHash('sha256').update(patch).digest('hex'), idempotencyKey: input.idempotencyKey,
			expectedDestinationRefHead: workspace.baseCommitSha }]);
		expect(result).toBe(receipt); expect(input).toEqual(before);
	});
	it('denies malformed empty unknown relation and extra endpoint fields in the existing canonical Note schema without rewriting proposal authorities', () => {
		const f = relationInputs(), before = structuredClone(f.note); expect(validateContentFrontmatter('note', f.note).ok).toBe(true);
		const invalid = [undefined, null, {}, { ...f.note, schemaVersion: 'invalid' }, { ...f.note, links: [{ ...f.link, relation: 'invented_dependency' }] },
			{ ...f.note, links: [{ ...f.link, from: { ...f.link.from, commit: '' } }] },
			{ ...f.note, links: [{ ...f.link, from: { ...f.link.from, digest: 'sha256:invalid' } }] },
			{ ...f.note, links: [{ ...f.link, to: { ...f.link.to, executionPlanId: 'caller-invented' } }] }];
		for (const value of invalid) expect(validateContentFrontmatter('note', value).ok).toBe(false);
		expect(f.note).toEqual(before); expect(parse(noteSource().split('---\n')[1]!)).toEqual(before);
	});
	it('rejects duplicate changeset paths and preserves no newline deletion and exact input replay using the original patch implementation', () => {
		const changes = [{ path: relationPath, before: null, after: 'exact bytes' }], before = structuredClone(changes);
		expect(() => createUnifiedChangeset([...changes, ...changes])).toThrow(/Duplicate changeset path/u);
		expect(createUnifiedChangeset(changes)).toContain('\\ No newline at end of file');
		expect(createUnifiedChangeset(changes)).toBe(createUnifiedChangeset(changes)); expect(changes).toEqual(before);
		expect(createUnifiedChangeset([{ path: relationPath, before: 'exact bytes\n', after: null }])).toContain('+++ /dev/null');
		expect(createUnifiedChangeset([{ path: relationPath, before: 'exact bytes\n', after: 'exact bytes\n' }])).toBe('');
	});
	it('requires both graph and search exact committed source closure and preserves failed native graph job disposition instead of reporting completion', async () => {
		const commit = 'a'.repeat(40), input = { projectId: 'precursor', commitSha: commit, graph: { resolvedRef: commit }, search: { resolvedRef: commit, stale: false } };
		const before = structuredClone(input); expect(() => requireIndexedSourceClosure(input)).not.toThrow();
		for (const value of [{ ...input, graph: {} }, { ...input, graph: { resolvedRef: 'b'.repeat(40) } },
			{ ...input, search: {} }, { ...input, search: { resolvedRef: commit, stale: true } }]) expect(() => requireIndexedSourceClosure(value)).toThrow(/stale/u);
		expect(input).toEqual(before);
		await expect(completedGraphRefresh({ refreshGraph: async () => ({ graph: { jobId: 'input-job' } }),
			getGraphRefreshJob: async () => ({ job: { status: 'failed', errorCode: 'input-index-failed' } }) },
			{ repoId: 'input-repo', ref: commit })).rejects.toThrow('input-index-failed');
	});
});
