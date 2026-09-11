import { describe, expect, it } from 'vitest';
import { candidateFixture } from './fixture.ts';
import { assignmentPredecessorCandidate } from '../../../../../../src/api/control-plane/repositories/providers/source/candidate-handoff.ts';
import { assertDurableSourceCloseout } from '../../../../../../src/api/control-plane/repositories/providers/source/candidate-closeout.ts';

describe('durable source continuity', () => {
  const repository = { id: 'repo', provider: 'github' as const, owner: 'example', name: 'project', cloneUrl: 'https://github.com/example/project.git', ref: 'staging' };
  it('selects the accepted candidate only through the same-project parent assignment', async () => {
    const f = candidateFixture(), parent = { id: 'assignment', status: 'completed', attempt_count: 1 }, child = { parent_assignment_id: 'assignment', team_id: 'team', project_id: 'project' };
    const db = { first: async () => parent, all: async () => [{ id: 'candidate', attestation_json: f.candidate.attestation }] };
    expect(await assignmentPredecessorCandidate(db as never, child, repository, 'control')).toMatchObject({ id: 'candidate' });
    parent.status = 'running'; await expect(assignmentPredecessorCandidate(db as never, child, repository, 'control')).rejects.toThrow('completed parent');
    parent.status = 'completed'; f.candidate.attestation.source.teamId = 'other';
    await expect(assignmentPredecessorCandidate(db as never, child, repository, 'control')).rejects.toThrow('another source');
  });
  it('never substitutes a released ref for missing source-producing parent work', async () => {
    const db = { first: async () => ({ status: 'completed', allowed_outputs_json: { artifactKinds: ['source-candidate'] } }), all: async () => [] };
    await expect(assignmentPredecessorCandidate(db as never, { parent_assignment_id: 'parent', team_id: 'team', project_id: 'project' }, repository, 'control')).rejects.toThrow('do not fall back');
  });
  it('blocks source-producing closeout until accepted custody exists', async () => {
    const actor = { teamId: 'team', capacityProviderId: 'provider', membershipId: 'membership', scopes: [] };
    let accepted = false;
    const db = { first: async (sql: string) => sql.includes('provider_source_candidates') ? accepted ? { id: 'candidate' } : null
      : { mode: 'acting', execution_kind: 'workday', allowed_outputs_json: { artifactKinds: ['source-candidate'] }, attempt_count: 1, project_id: 'project' } };
    await expect(assertDurableSourceCloseout(db as never, actor, 'assignment')).rejects.toThrow('Persist and verify');
    accepted = true; await expect(assertDurableSourceCloseout(db as never, actor, 'assignment')).resolves.toBeUndefined();
  });
});
