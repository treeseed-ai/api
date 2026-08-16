import { describe,expect,it,vi } from 'vitest';
import { assertPlanningArtifactContent,assignmentWorkdayRunId,persistAssignmentProposalRevision,projectCompletedPlanningOutputs } from '../../../../../src/api/capacity/services/capacity/assignments/planning/assignment-planning-output-service.ts';

const assignment = {
	id: 'assignment-a', teamId: 'team-a', projectId: 'project-a', decisionId: 'decision-a',
	agentId: 'engineer', mode: 'planning', decisionInput: { input: { planningInputRequestId: 'request-a' } },
} as never;

const estimate = {
	id: 'estimate-a', teamId: 'team-a', projectId: 'project-a', decisionId: 'decision-a', proposalId: 'proposal-a',
	agentClass: 'engineering', agentId: 'engineer', minSeconds: 1, expectedSeconds: 2, maxSeconds: 3,
	confidence: 'medium', riskLevel: 'low', assumptions: [], blockers: [], dependencies: [],
	expectedOutputs: [{ outputType: 'implementation', required: true }], acceptanceCriteria: ['tests pass'], completionEvidence: [],
	createdAt: '2026-07-18T00:00:00.000Z', metadata: {},
};

describe('assignment planning output projection', () => {
	it('resolves the API workday run from assignment metadata instead of the child project envelope id', () => {
		expect(assignmentWorkdayRunId({ workDayId: 'workday-run-a-project-a', metadata: { workdayRunId: 'run-a' } } as never)).toBe('run-a');
		expect(assignmentWorkdayRunId({ workDayId: 'legacy-run-a', metadata: {} } as never)).toBe('legacy-run-a');
	});

	it('rejects malformed TreeDX proposal artifacts with field-addressable diagnostics', () => {
		expect(() => assertPlanningArtifactContent('proposal','src/content/proposals/invalid.mdx',{ title:'Invalid proposal' },'assignment-a'))
			.toThrow(expect.objectContaining({
				code:'assignment_content_model_invalid',status:409,
				details:expect.objectContaining({ contentPath:'src/content/proposals/invalid.mdx',model:'proposal',
					diagnostics:expect.arrayContaining([expect.objectContaining({ field:'description',code:'content_zod_invalid_type' })]) }),
			}));
	});

	it('persists a correlated structured estimate once as submitted planning evidence', async () => {
		const create = vi.fn(async (_decisionId: string, input: Record<string, unknown>) => ({ ...estimate, ...input }));
		const run = vi.fn(async () => undefined);
		const store = { run, getStructuredAgentEstimate: vi.fn(async () => null), createStructuredAgentEstimate: create };
		await expect(projectCompletedPlanningOutputs(store as never, assignment, { output: { metadata: { structuredEstimate: estimate } } }))
			.resolves.toMatchObject({ id: 'estimate-a', status: 'submitted', metadata: { assignmentId: 'assignment-a' } });
		expect(create).toHaveBeenCalledWith('decision-a', expect.objectContaining({ status: 'submitted', recordMetadata: { source: 'validated_assignment_planning_output', assignmentId: 'assignment-a' } }));
		expect(run).toHaveBeenCalledWith(expect.stringContaining(`UPDATE agent_invocation_requests SET status = 'completed'`), expect.arrayContaining(['request-a', 'team-a', 'project-a']));
	});

	it('returns the assignment-owned estimate on replay and rejects cross-scope output', async () => {
		const existing = { ...estimate, status: 'submitted', metadata: { assignmentId: 'assignment-a' } };
		const store = { run: vi.fn(async () => undefined), getStructuredAgentEstimate: vi.fn(async () => existing), createStructuredAgentEstimate: vi.fn() };
		await expect(projectCompletedPlanningOutputs(store as never, assignment, { output: { metadata: { structuredEstimate: estimate } } })).resolves.toBe(existing);
		expect(store.createStructuredAgentEstimate).not.toHaveBeenCalled();
		await expect(projectCompletedPlanningOutputs(store as never, assignment, { output: { metadata: { structuredEstimate: { ...estimate, projectId: 'project-b' } } } }))
			.rejects.toMatchObject({ code: 'assignment_planning_estimate_scope_invalid' });
	});

	it('accepts a proposal-scoped pre-governance estimate without projecting it into decision planning', async () => {
		const proposalAssignment = { ...assignment, decisionId: null, decisionInput: { input: { proposalId: 'proposal-a', intent: { subjectId: 'proposal-a' } } } };
		const proposalEstimate = { ...estimate, decisionId: null };
		const store = { run: vi.fn(async () => undefined), getStructuredAgentEstimate: vi.fn(), createStructuredAgentEstimate: vi.fn() };
		await expect(projectCompletedPlanningOutputs(store as never, proposalAssignment as never, { output: { metadata: { structuredEstimate: proposalEstimate } } }))
			.resolves.toMatchObject({ id: 'estimate-a', proposalId: 'proposal-a' });
		expect(store.createStructuredAgentEstimate).not.toHaveBeenCalled();
		await expect(projectCompletedPlanningOutputs(store as never, proposalAssignment as never, { output: { metadata: { structuredEstimate: { ...proposalEstimate, proposalId: 'proposal-b' } } } }))
			.rejects.toMatchObject({ code: 'assignment_planning_estimate_scope_invalid' });
	});

	it('keeps objective-linked discovery questions out of proposal feedback registration', async () => {
		const discoveryAssignment = { ...assignment, decisionId: null, projectAgentClassId: 'project-a:evidence', decisionInput: { input: {} } };
		const store = { getGovernanceProposal: vi.fn(), getStructuredAgentEstimate: vi.fn(), createStructuredAgentEstimate: vi.fn(), run: vi.fn() };
		const artifactManifest = {
			schemaVersion: 1, assignmentId: 'assignment-a', modeRunId: 'mode-a', teamId: 'team-a', projectId: 'project-a',
			providerId: 'provider-a', mode: 'planning', agentClassId: 'project-a:evidence', agentId: 'engineer', handlerId: 'writer',
			activityType: 'planning', status: 'completed', summary: 'Recorded a bounded evidence gap.', toolEvents: [],
			contentReferences: [{ model: 'question', contentPath: 'src/content/questions/evidence-gap.mdx', receiptId: 'receipt-a', toolEventId: 'tool-a',
				subjectId: 'objective-a', subjectField: 'relatedObjectives', artifactKind: 'planning_question', commitSha: 'commit-a' }],
			verification: [], citations: [], signals: [], usage: [], diagnostics: [], createdAt: '2026-08-04T00:00:00.000Z',
		};
		await expect(projectCompletedPlanningOutputs(store as never, discoveryAssignment as never, { output: { artifactManifest } })).resolves.toBeNull();
		expect(store.getGovernanceProposal).not.toHaveBeenCalled();
	});

	it('publishes a provenance-linked agent revision and replays its immutable digest',async () => {
		const revisionAssignment = { ...assignment,workDayId: 'workday-a',decisionInput: { input: { intent: { relatedArtifact: { model: 'proposal',commitSha: 'base-commit' } } } } } as never;
		const existing = { id: 'proposal-a',activeVersion: 2,metadata: { contentProvenance: { commitSha: 'base-commit',digest: 'base-digest' } } };
		const updated = { ...existing,activeVersion: 3,metadata: { contentProvenance: { commitSha: 'revision-commit',digest: 'revision-digest' } } };
		const store = { updateGovernanceProposalDraft: vi.fn(async () => updated),getGovernanceProposal: vi.fn(async () => updated) };
		await expect(persistAssignmentProposalRevision({
			store: store as never,assignment: revisionAssignment,existing,proposalId: 'proposal-a',digest: 'revision-digest',
			contentProvenance: { commitSha: 'revision-commit',digest: 'revision-digest' },proposal: { title: 'Revision',summary: 'Summary',body: 'Body' },
		})).resolves.toBe(updated);
		expect(store.updateGovernanceProposalDraft).toHaveBeenCalledWith(expect.objectContaining({ id: 'engineer',type: 'agent' }),'proposal-a',expect.objectContaining({
			expectedProposalVersion: 2,createdByType: 'agent',createdById: 'engineer',contentProvenance: expect.objectContaining({ digest: 'revision-digest' }),
		}));
		await expect(persistAssignmentProposalRevision({
			store: store as never,assignment: revisionAssignment,existing: updated,proposalId: 'proposal-a',digest: 'revision-digest',
			contentProvenance: { commitSha: 'revision-commit',digest: 'revision-digest' },proposal: {},
		})).resolves.toBe(updated);
		expect(store.updateGovernanceProposalDraft).toHaveBeenCalledTimes(1);
	});

	it('rejects a stale proposal revision without overwriting the current version',async () => {
		const store = { updateGovernanceProposalDraft: vi.fn(),getGovernanceProposal: vi.fn() };
		await expect(persistAssignmentProposalRevision({
			store: store as never,
			assignment: { ...assignment,decisionInput: { input: { intent: { relatedArtifact: { model: 'proposal',commitSha: 'stale-commit' } } } } } as never,
			existing: { activeVersion: 4,metadata: { contentProvenance: { commitSha: 'current-commit',digest: 'current-digest' } } },
			proposalId: 'proposal-a',digest: 'revision-digest',contentProvenance: { commitSha: 'revision-commit',digest: 'revision-digest' },proposal: {},
		})).rejects.toMatchObject({ code: 'assignment_proposal_revision_stale',status: 409 });
		expect(store.updateGovernanceProposalDraft).not.toHaveBeenCalled();
	});
});
