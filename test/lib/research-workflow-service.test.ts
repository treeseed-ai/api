import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { DataType, newDb } from 'pg-mem';
import { describe, expect, it } from 'vitest';
import { MarketPostgresDatabase } from '../../src/api/market-postgres.ts';
import { MarketControlPlaneStore } from '../../src/api/store.ts';
import { createCapacityControlPlane } from '../../src/api/capacity/control-plane.ts';
import { resolvePlanningDemandSource } from '../../src/api/capacity/services/planning-demand-source.ts';
import { projectCompletedResearchWorkflow } from '../../src/api/capacity/services/research-workflow-projection-service.ts';

const packageRoot = process.cwd();
const migrationRoot = existsSync(resolve(packageRoot, '../sdk/drizzle/market')) ? resolve(packageRoot, '../sdk/drizzle/market') : resolve(packageRoot, 'node_modules/@treeseed/sdk/drizzle/market');
function harness() {
	const memory = newDb();
	memory.public.registerFunction({ name: 'md5', args: [DataType.text], returns: DataType.text, implementation: (value: string) => `md5:${value}` });
	const pg = memory.adapters.createPg();
	const database = MarketPostgresDatabase.fromPool(new pg.Pool(), { migrationRoot });
	return { database, store: createCapacityControlPlane(new MarketControlPlaneStore({ repoRoot: packageRoot }, database)) };
}
async function seed(store: ReturnType<typeof harness>['store']) {
	const now = new Date().toISOString();
	await store.ensureInitialized();
	await store.run(`INSERT INTO teams (id, slug, name, created_at, updated_at) VALUES ('team-a', 'team-a', 'Team A', ?, ?)`, [now, now]);
	await store.run(`INSERT INTO projects (id, team_id, slug, name, created_at, updated_at) VALUES ('project-a', 'team-a', 'project-a', 'Project A', ?, ?)`, [now, now]);
}
const citation = (id: string, publisher: string) => ({ sourceUrl: `https://${publisher}/${id}`, title: `Source ${id}`, publisher, retrievedAt: '2026-07-18T00:00:00.000Z', contentHash: `sha256:${id.repeat(64)}`, claimIds: ['claim-1'], confidence: 'high' });

describe('durable research workflow service', () => {
	it('persists and CAS-advances rejection, revision, publication, and reporting', async () => {
		const { database, store } = harness();
		try {
			await seed(store);
			let workflow = await store.createResearchWorkflow('project-a', { id: 'research-a', objectiveRef: 'objective:a', questionRef: 'question:a', maxRevisionCycles: 2, idempotencyKey: 'research:a' });
			expect(workflow).toMatchObject({ maxRevisionCycles: 2 });
			expect(await store.createResearchWorkflow('project-a', { id: 'other', objectiveRef: 'objective:a', questionRef: 'question:a', maxRevisionCycles: 2, idempotencyKey: 'research:a' })).toEqual(workflow);
			const complete = async (stage: string, extra: Record<string, unknown> = {}) => {
				workflow = await store.completeResearchWorkflowStage(workflow!.id, stage, { expectedStateVersion: workflow!.stateVersion, assignmentId: `assignment:${stage}`, artifactRefs: [`artifact:${stage}`], ...extra });
			};
			await complete('question-decomposition'); await complete('source-selection-criteria'); await complete('governed-source-search');
			await complete('independent-source-fetch', { citations: [citation('a', 'one.test'), citation('b', 'two.test')] });
			await complete('linked-evidence-notes', { artifactRefs: ['note:one', 'note:two'] });
			await complete('claim-synthesis', { claims: [{ id: 'claim-1', text: 'Unsupported material claim', material: true, status: 'unsupported', citationIds: [] }] });
			await complete('citation-review-rejection', { reviewOutcome: 'rejected', reviewReason: 'No supporting citation.' });
			await complete('revision', { claims: [{ id: 'claim-1', text: 'Revised material claim', material: true, status: 'supported', citationIds: ['a', 'b'] }] });
			await complete('citation-review-approval', { reviewOutcome: 'approved' });
			await complete('cited-knowledge-publication', { publicationRef: 'knowledge:final' });
			await complete('workday-report', { reportRef: 'note:report' });
			expect(workflow).toMatchObject({ status: 'completed', stateVersion: 12, reviewerRejectedUnsupportedClaims: true, reviewerApprovedRevision: true, revisionCount: 1, publicationRef: 'knowledge:final', reportRef: 'note:report' });
			expect(workflow?.citations).toHaveLength(2);
			expect(await store.listResearchWorkflows('project-a', { status: 'completed' })).toEqual([expect.objectContaining({ id: 'research-a' })]);
		} finally { await database.close(); }
	});

	it('fails closed for stale state and invalid ordering without mutating the workflow', async () => {
		const { database, store } = harness();
		try {
			await seed(store);
			const workflow = await store.createResearchWorkflow('project-a', { id: 'research-a', objectiveRef: 'objective:a', questionRef: 'question:a', idempotencyKey: 'research:a' });
			await expect(store.completeResearchWorkflowStage(workflow!.id, 'governed-source-search', { expectedStateVersion: 1, assignmentId: 'a', artifactRefs: ['a'] })).rejects.toMatchObject({ code: 'research_workflow_stage_not_ready', message: expect.stringContaining('research_workflow_stage_not_ready') });
			await expect(store.completeResearchWorkflowStage(workflow!.id, 'question-decomposition', { expectedStateVersion: 0, assignmentId: 'a', artifactRefs: ['a'] })).rejects.toMatchObject({ code: 'research_workflow_state_conflict' });
			expect(await store.getResearchWorkflow(workflow!.id)).toMatchObject({ stateVersion: 1, status: 'ready' });
		} finally { await database.close(); }
	});

	it('projects only the ready workflow stage to its configured research role', async () => {
		const { database, store } = harness();
		try {
			await seed(store);
			const workflow = await store.createResearchWorkflow('project-a', { id: 'research-a', objectiveRef: 'objective:a', questionRef: 'question:a', idempotencyKey: 'research:a' });
			const run = { id: 'run-a', teamId: 'team-a' } as never;
			const intent = { objective: 'Research', artifactKind: 'research_note', subjectModel: 'question', subjectId: 'question:a', includeWorkdayArtifacts: false };
			const researcher = { slug: 'researcher', handler: 'writer', projectAgentClassId: 'class-research', projectAgentClassSlug: 'research', purpose: 'Research', promptTask: 'planning', outputContract: {}, planningIntent: {}, planningPriority: 1, planningAllocationPercent: null, activityType: 'planning' as const };
			await expect(resolvePlanningDemandSource(store, run, { id: 'project-a' }, { ...researcher, slug: 'reviewer' }, intent)).resolves.toMatchObject({ sourceType: expect.not.stringMatching(/^research-workflow$/u) });
			await expect(resolvePlanningDemandSource(store, run, { id: 'project-a' }, researcher, intent)).resolves.toMatchObject({
				sourceType: 'research-workflow', sourceId: `${workflow!.id}:question-decomposition`, priority: 100,
				payload: { researchWorkflowId: workflow!.id, researchWorkflowStateVersion: 1, researchStage: 'question-decomposition', questionRef: 'question:a', intent: { artifactKind: 'planning_question', subjectModel: 'question', subjectId: 'a' } },
			});
		} finally { await database.close(); }
	});

	it('advances a ready stage from canonical assignment artifact evidence and replays idempotently', async () => {
		const { database, store } = harness();
		try {
			await seed(store);
			const workflow = await store.createResearchWorkflow('project-a', { id: 'research-a', objectiveRef: 'objective:a', questionRef: 'question:a', idempotencyKey: 'research:a' });
			const assignment = { id: 'assignment-a', teamId: 'team-a', projectId: 'project-a', mode: 'planning' } as never;
			const projectionStore = {
				first: async () => ({ id: 'demand-a', payload_json: JSON.stringify({ researchWorkflowId: workflow!.id, researchWorkflowStateVersion: 1, researchStage: 'question-decomposition' }) }),
				getResearchWorkflow: store.getResearchWorkflow.bind(store),
				completeResearchWorkflowStage: store.completeResearchWorkflowStage.bind(store),
			};
			const input = { artifactManifest: {
				schemaVersion: 1, assignmentId: 'assignment-a', modeRunId: 'mode-a', teamId: 'team-a', projectId: 'project-a', providerId: 'provider-a', mode: 'planning',
				agentClassId: 'class-research', agentId: 'researcher', handlerId: 'writer', activityType: 'planning', status: 'completed', summary: 'Questions decomposed.',
				toolEvents: [], contentReferences: [{ model: 'note', contentPath: 'notes/research/questions.mdx', receiptId: 'receipt-a', toolEventId: 'tool-a', subjectId: 'question:a', subjectField: 'relatedQuestions', artifactKind: 'research_question_decomposition' }],
				verification: [], citations: [], signals: [], usage: [], diagnostics: [], createdAt: '2026-07-18T00:00:00.000Z',
			} };
			const advanced = await projectCompletedResearchWorkflow(projectionStore, assignment, input);
			expect(advanced).toMatchObject({ stateVersion: 2 });
			expect(advanced?.nodes.slice(0, 2)).toEqual([expect.objectContaining({ status: 'completed', assignmentId: 'assignment-a' }), expect.objectContaining({ status: 'ready' })]);
			await expect(projectCompletedResearchWorkflow(projectionStore, assignment, input)).resolves.toMatchObject({ stateVersion: 2 });
		} finally { await database.close(); }
	});

	it('preserves prior citations when a later artifact manifest declares none', async () => {
		const { database, store } = harness();
		try {
			await seed(store);
			let workflow = await store.createResearchWorkflow('project-a', { id: 'research-a', objectiveRef: 'objective:a', questionRef: 'question:a', idempotencyKey: 'research:a' });
			for (const stage of ['question-decomposition', 'source-selection-criteria', 'governed-source-search']) workflow = await store.completeResearchWorkflowStage(workflow!.id, stage, { expectedStateVersion: workflow!.stateVersion, assignmentId: `assignment:${stage}`, artifactRefs: [`artifact:${stage}`] });
			workflow = await store.completeResearchWorkflowStage(workflow!.id, 'independent-source-fetch', { expectedStateVersion: workflow!.stateVersion, assignmentId: 'assignment:fetch', artifactRefs: ['artifact:fetch'], citations: [citation('a', 'one.test'), citation('b', 'two.test')] });
			const assignment = { id: 'assignment-evidence', teamId: 'team-a', projectId: 'project-a', mode: 'planning' } as never;
			const projectionStore = {
				first: async () => ({ id: 'demand-a', payload_json: JSON.stringify({ researchWorkflowId: workflow!.id, researchWorkflowStateVersion: workflow!.stateVersion, researchStage: 'linked-evidence-notes' }) }),
				getResearchWorkflow: store.getResearchWorkflow.bind(store), completeResearchWorkflowStage: store.completeResearchWorkflowStage.bind(store),
			};
			const input = { artifactManifest: {
				schemaVersion: 1, assignmentId: assignment.id, modeRunId: 'mode-evidence', teamId: 'team-a', projectId: 'project-a', providerId: 'provider-a', mode: 'planning',
				agentClassId: 'class-research', agentId: 'researcher', handlerId: 'writer', activityType: 'planning', status: 'completed', summary: 'Evidence notes created.', toolEvents: [],
				contentReferences: [1, 2].map((value) => ({ model: 'note', contentPath: `notes/research/evidence-${value}.mdx`, receiptId: `receipt-${value}`, toolEventId: `tool-${value}`, subjectId: 'question:a', subjectField: 'relatedQuestions', artifactKind: 'research_evidence' })),
				verification: [], citations: [], signals: [], usage: [], diagnostics: [], createdAt: '2026-07-18T00:00:00.000Z',
			} };
			await expect(projectCompletedResearchWorkflow(projectionStore, assignment, input)).resolves.toMatchObject({ citations: expect.arrayContaining([expect.objectContaining({ publisher: 'one.test' }), expect.objectContaining({ publisher: 'two.test' })]) });
		} finally { await database.close(); }
	});

	it('projects a post-revision rejection into another durable revision cycle', async () => {
		const { database, store } = harness();
		try {
			await seed(store);
			let workflow = await store.createResearchWorkflow('project-a', { id: 'research-loop', objectiveRef: 'objective:a', questionRef: 'question:a', idempotencyKey: 'research:loop' });
			const complete = async (stage: string, extra: Record<string, unknown> = {}) => {
				workflow = await store.completeResearchWorkflowStage(workflow!.id, stage, { expectedStateVersion: workflow!.stateVersion, assignmentId: `assignment:${stage}`, artifactRefs: [`artifact:${stage}`], ...extra });
			};
			await complete('question-decomposition'); await complete('source-selection-criteria'); await complete('governed-source-search');
			await complete('independent-source-fetch', { citations: [citation('a', 'one.test'), citation('b', 'two.test')] });
			await complete('linked-evidence-notes', { artifactRefs: ['note:one', 'note:two'] });
			await complete('claim-synthesis', { claims: [{ id: 'claim-1', text: 'Unsupported', material: true, status: 'unsupported', citationIds: [] }] });
			await complete('citation-review-rejection', { reviewOutcome: 'rejected', reviewReason: 'Missing support.' });
			await complete('revision', { claims: [{ id: 'claim-1', text: 'First revision', material: true, status: 'supported', citationIds: ['a', 'b'] }] });
			const assignment = { id: 'assignment-review-again', teamId: 'team-a', projectId: 'project-a', mode: 'planning' } as never;
			const projectionStore = {
				first: async () => ({ id: 'demand-review-again', payload_json: JSON.stringify({ researchWorkflowId: workflow!.id, researchWorkflowStateVersion: workflow!.stateVersion, researchStage: 'citation-review-approval' }) }),
				getResearchWorkflow: store.getResearchWorkflow.bind(store), completeResearchWorkflowStage: store.completeResearchWorkflowStage.bind(store),
			};
			const input = { artifactManifest: {
				schemaVersion: 1, assignmentId: assignment.id, modeRunId: 'mode-review-again', teamId: 'team-a', projectId: 'project-a', providerId: 'provider-a', mode: 'planning',
				agentClassId: 'class-review', agentId: 'reviewer', handlerId: 'writer', activityType: 'planning', status: 'completed', summary: 'Revision still needs evidence-bounded wording.', toolEvents: [],
				contentReferences: [{ model: 'note', contentPath: 'notes/research/review-again.mdx', receiptId: 'receipt-review', toolEventId: 'tool-review', subjectId: 'question:a', subjectField: 'relatedQuestions', artifactKind: 'planning_note' }],
				verification: [], citations: [], signals: [{ code: 'research_review_rejected', severity: 'warning', message: 'The cited evidence still does not substantiate the wording.', metadata: { source: 'treeseed.review_decision' } }], usage: [], diagnostics: [], createdAt: '2026-07-18T00:00:00.000Z',
			} };
			await expect(projectCompletedResearchWorkflow(projectionStore, assignment, input)).resolves.toMatchObject({
				status: 'running', stateVersion: 10, reviewerApprovedRevision: false, revisionCount: 1,
				nodes: expect.arrayContaining([expect.objectContaining({ stage: 'revision', status: 'ready' }), expect.objectContaining({ stage: 'citation-review-approval', status: 'pending' })]),
			});
			const run = { id: 'run-revision', teamId: 'team-a' } as never;
			const researcher = { slug: 'researcher', handler: 'writer', projectAgentClassId: 'class-research', projectAgentClassSlug: 'research', purpose: 'Research', promptTask: 'planning', outputContract: {}, planningIntent: {}, planningPriority: 1, planningAllocationPercent: null, activityType: 'planning' as const };
			const intent = { objective: 'Revise research', artifactKind: 'planning_note', subjectModel: 'question', subjectId: 'question:a', includeWorkdayArtifacts: false };
			await expect(resolvePlanningDemandSource(store, run, { id: 'project-a' }, researcher, intent)).resolves.toMatchObject({
				sourceType: 'research-workflow',
				payload: { researchStage: 'revision', revisionCount: 1, maxRevisionCycles: 3, latestReviewAttempt: { stage: 'citation-review-approval', outcome: 'rejected', reason: 'The cited evidence still does not substantiate the wording.' } },
			});
		} finally { await database.close(); }
	});
});
