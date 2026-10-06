import { describe, expect, it } from 'vitest';
import { providerRefAuthority } from '../../../../../src/api/control-plane/repositories/treedx/provider-ref-authority.ts';

const base = 'a'.repeat(40), produced = 'b'.repeat(40);
const handle = { projectId: 'project', metadata: { baseCommitSha: base, baseRef: base, branchName: 'refs/heads/assignment-one', readRepositories: [{ projectId: 'team', baseRef: 'c'.repeat(40) }] } };
describe('assignment TreeDX reference authority', () => {
  it('preserves exact base and private branch for workspace operations', () => {
    expect(providerRefAuthority({ handle, projectId: 'project', workspace: true })).toEqual({ ref: base, refs: [base, 'refs/heads/assignment-one'] });
  });
  it('defaults reads to the pinned commit rather than a moving staging head', () => {
    expect(providerRefAuthority({ handle, projectId: 'project', workspace: false })).toEqual({ ref: base, refs: [base] });
  });
  it('permits exact read-back of this assignment’s journaled commit only', () => {
    expect(providerRefAuthority({ handle, projectId: 'project', workspace: false, requestedRef: produced, producedCommits: [produced] }).refs).toEqual([produced]);
    expect(() => providerRefAuthority({ handle, projectId: 'project', workspace: false, requestedRef: produced })).toThrow('outside');
    expect(() => providerRefAuthority({ handle, projectId: 'project', workspace: false, requestedRef: 'main', producedCommits: ['main'] })).toThrow('outside');
  });
  it('permits multiple exact commits from the same project library when each is explicitly granted', () => {
    const proposal = 'd'.repeat(40);
    const multi = { ...handle, metadata: { ...handle.metadata, readRepositories: [
      { projectId: 'project', baseRef: base }, { projectId: 'project', baseRef: proposal },
    ] } };
    expect(providerRefAuthority({ handle: multi, projectId: 'project', workspace: false, requestedRef: proposal }))
      .toEqual({ ref: proposal, refs: [proposal] });
    expect(() => providerRefAuthority({ handle: multi, projectId: 'project', workspace: false, requestedRef: 'e'.repeat(40) }))
      .toThrow('outside');
  });
  it('keeps cross-project access read-only and pinned', () => {
    expect(providerRefAuthority({ handle, projectId: 'team', workspace: false }).ref).toBe('c'.repeat(40));
    expect(() => providerRefAuthority({ handle, projectId: 'team', workspace: true })).toThrow('Secondary project');
    expect(() => providerRefAuthority({ handle, projectId: 'team', workspace: false, requestedRef: produced, producedCommits: [produced] })).toThrow('outside');
    expect(() => providerRefAuthority({ handle, projectId: 'unrelated', workspace: false })).toThrow('no pinned');
  });
	 it('separates the assignment project from a Team Library primary workspace', () => {
		const reporter = { ...handle, repositoryProjectId:'team', metadata:{ ...handle.metadata, repositoryProjectId:'team',
			readRepositories:[{ projectId:'team', baseRef:base }, { projectId:'project', baseRef:'c'.repeat(40) }] } };
		expect(providerRefAuthority({ handle:reporter, projectId:'team', workspace:true }).ref).toBe(base);
		expect(providerRefAuthority({ handle:reporter, projectId:'project', workspace:false }).ref).toBe('c'.repeat(40));
		expect(() => providerRefAuthority({ handle:reporter, projectId:'project', workspace:true })).toThrow('Secondary project');
	 });
});
