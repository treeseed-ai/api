import { describe, expect, it, vi } from 'vitest';
import { assignmentInput } from '../../../../../src/api/capacity/services/capacity/assignments/planning/assignment-function.ts';

vi.mock('../../../../../src/api/capacity/policy/supply-selection.ts', () => ({
  capacitySupplyCandidateStatus: () => 'available',
  selectCapacitySupply: () => ({ selected: { executionProviderId: 'provider' }, rejected: [] }),
}));
vi.mock('../../../../../src/api/capacity/services/capacity/assignments/planning/admission/battery-admission.ts', () => ({ assertBatteryAdmission: async () => undefined }));
vi.mock('../../../../../src/api/capacity/services/capacity/assignments/planning/context/cross-project-read-repositories.ts', () => ({ resolveCrossProjectReadRepositories: async () => [] }));

describe('immutable identity on compiled assignments', () => {
  it.each(['conversation', 'workday'] as const)('binds %s identity to the actual project and team library revisions', async executionKind => {
    const ref = 'a'.repeat(40), teamRef = 'b'.repeat(40);
    const store = {
      getProject: async () => ({ id: 'project', slug: 'sdk' }),
      getProjectByTeamAndSlug: async () => ({ id: 'team-library', metadata: { provisioning: { state: 'known-good' } } }),
      getProjectTreeDxLibrary: async () => ({ repositoryId: 'team-repo', metadata: { resolvedRef: teamRef } }),
      first: async () => ({ count: 0 }),
    };
    const demand = {
      id: 'demand', claimToken: 'claim', teamId: 'team', projectId: 'project',
      workdayId: 'day', workdayRunId: 'run', projectAgentClassId: 'review',
      agentId: 'reviewer', handlerId: 'writer', activityType: 'reviewing', mode: 'planning', requestedSeconds: 180,
      metadata: { executionKind, executionMode: 'production' },
      payload: { repositoryId: 'project-repo', contentRoot: '.', contentBaseRef: ref, agentContentPath: 'agents/reviewer.mdx',
        intent: { artifactKind: 'proposal_feedback_note', subjectModel: 'proposal', subjectId: 'proposal' } },
    };
    const providers = [{ id: 'provider', offers: [], capabilities: [], status: 'available', lanes: [
      { id: 'communication', purpose: 'communication', capabilities: [], maxConcurrentRunners: 1 },
      { id: 'workday', purpose: 'workday', capabilities: [], maxConcurrentRunners: 1 },
    ] }];
    const result = await assignmentInput(store as never, demand as never,
      { teamId: 'team', capacityProviderId: 'host', membershipId: 'membership' } as never,
      'session', providers as never, {} as never, '2026-09-11T15:00:00Z');
    expect(result.metadata.identityManifest).toMatchObject({
      agentHandle: '@sdk/reviewer', repositoryId: 'project-repo', immutableRef: ref,
      agentProfile: { path: 'agents/reviewer.mdx', expectedRevision: ref },
      coreObjective: { path: 'objectives/core', expectedRevision: ref },
      projectReadme: { path: 'README.md', expectedRevision: ref },
      teamLibrary: { projectId: 'team-library', repositoryId: 'team-repo', immutableRef: teamRef },
    });
    expect(result.allowedOutputs.types).toContain('proposal_feedback_note');
  });
});
