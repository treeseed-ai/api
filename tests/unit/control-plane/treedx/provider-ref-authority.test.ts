import { describe, expect, it } from 'vitest';
import { providerRefAuthority } from '../../../../src/api/control-plane/repositories/treedx/provider-ref-authority.ts';

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
  it('keeps cross-project access read-only and pinned', () => {
    expect(providerRefAuthority({ handle, projectId: 'team', workspace: false }).ref).toBe('c'.repeat(40));
    expect(() => providerRefAuthority({ handle, projectId: 'team', workspace: true })).toThrow('Cross-project');
    expect(() => providerRefAuthority({ handle, projectId: 'team', workspace: false, requestedRef: produced, producedCommits: [produced] })).toThrow('outside');
    expect(() => providerRefAuthority({ handle, projectId: 'unrelated', workspace: false })).toThrow('no pinned');
  });
});
