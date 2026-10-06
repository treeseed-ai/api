import { assignmentAttemptSchema, assignmentResultSchema, type AssignmentAttempt } from '@treeseed/sdk/agent-capacity';
import { initialAdmission } from '../initial-admission-fixture.ts';
import { replayAttempt, replayInput } from '../../admission-replay-fixture.ts';
import { admitLivingExecutionAssignment } from '../../../../../../../../src/api/capacity/services/capacity/assignments/admission/living-execution-admission.ts';

// Supplied reviewed dependency facts, not native Actor/Reviewer execution,
// authenticated governance, generated usage or TreeDX/Git artifact custody.
export function dependencyInputs(base: AssignmentAttempt = replayAttempt()) {
	const decision = { store: 'treedx' as const, model: 'decision', id: 'producer-review', repository: 'library', commit: 'f'.repeat(40), path: 'decisions/producer.md' };
	const actor = assignmentResultSchema.parse({ schemaVersion: 'treeseed.assignment-result/v1', id: 'producer-result', assignmentId: 'producer-attempt', status: 'completed',
		summary: 'Supplied candidate input.', references: [{ kind: 'git', repository: 'treeseed-ai/sdk', commit: 'e'.repeat(40) }], verification: [],
		usage: { elapsedSeconds: 1 }, diagnostics: [], completedAt: base.createdAt });
	const review = assignmentResultSchema.parse({ ...actor, id: 'review-result', assignmentId: 'review-attempt', summary: 'Supplied independent review input.',
		references: [{ kind: 'treedx', projectId: base.projectId, repository: decision.repository, commit: decision.commit, path: decision.path }] });
	const attempt = assignmentAttemptSchema.parse({ ...base, predecessorResultIds: [actor.id, review.id],
		workspace: { ...base.workspace, mode: 'git', repository: 'treeseed-ai/sdk', baseCommit: 'e'.repeat(40), branch: 'simulation/fixture/workday/dependent', writablePaths: ['src'] },
		contextRefs: [...base.contextRefs, { store: 'git', model: 'repository', id: 'producer-candidate', repository: 'treeseed-ai/sdk', commit: 'e'.repeat(40) }, decision],
		grant: { ...base.grant, contentRead: [...base.grant.contentRead, decision] } });
	return { attempt, actor, review, decision };
}

export function dependencyUnitInput() {
	const facts = dependencyInputs(), input = replayInput(facts.attempt);
	input.predecessorResults = [facts.actor, facts.review]; return input;
}

export function admissionWriteGuard() {
	let writes = 0, reads = 0;
	const store: Parameters<typeof admitLivingExecutionAssignment>[0] = {
		ensureInitialized: async () => undefined,
		getProviderAssignment: async () => null,
		first: async () => { reads++; throw new Error('Unexpected unit SQL read'); },
		all: async () => { reads++; throw new Error('Unexpected unit SQL read'); },
		run: async () => { writes++; throw new Error('Unexpected unit SQL write'); },
		batch: async () => { writes++; throw new Error('Unexpected unit admission batch'); },
	};
	return { store, writes: () => writes, reads: () => reads };
}

// Existing original-DDL fixture and actual admission/repository/transaction path.
// Completion rows/edge projection are supplied SQL inputs. No query/write is mocked.
export async function dependencyAdmission(admissionNow?: string | (() => string), completeOriginalTables = false) {
	const f = await initialAdmission(admissionNow, completeOriginalTables);
	try {
		const facts = dependencyInputs(f.attempt), base = f.attempt;
		const actor = assignmentAttemptSchema.parse({ ...base, id: facts.actor.assignmentId, idempotencyKey: facts.actor.assignmentId,
			nodeId: 'producer-node', workItemId: 'producer', reservationId: 'producer-reservation', predecessorResultIds: [] });
		const review = assignmentAttemptSchema.parse({ ...base, id: facts.review.assignmentId, idempotencyKey: facts.review.assignmentId,
			nodeId: 'review-node', workItemId: 'producer', reservationId: 'review-reservation', predecessorResultIds: [facts.actor.id],
			effectiveProfile: { ...base.effectiveProfile, activity: 'reviewing', permissionCeiling: { content: { read: ['proposal', 'decision'], write: ['decision'] }, tools: [] } },
			grant: { contentRead: [base.sourceRef, facts.decision], contentWrite: [facts.decision], sourceRead: [], sourceWrite: [], tools: [] },
			workspace: { mode: 'treedx', workspaceId: 'supplied-review-workspace', repository: facts.decision.repository, baseCommit: facts.decision.commit, writablePaths: [facts.decision.path] } });
		for (const value of [actor, review]) {
			await f.seedNode(value);
			await f.query("UPDATE execution_nodes SET status='completed',pair_role=?,kind=?,work_item_id=? WHERE id=?", [value === actor ? 'actor' : 'reviewer', value === actor ? 'acting' : 'reviewing', 'producer', value.nodeId]);
			const result = value === actor ? facts.actor : facts.review;
			await f.query(`INSERT INTO capacity_provider_assignments (id,membership_id,team_id,project_id,capacity_provider_id,project_agent_class_id,
				work_day_id,mode,status,lease_state,execution_node_id,execution_node_revision,graph_revision,assignment_attempt_json,assignment_result_json,
				lifecycle_output_json,completed_at,created_at,updated_at)
				VALUES (?,'membership',?,?,'provider',?,?,'acting','completed','released',?,?,?,?,?,?,?,?,?)`,
				[value.id, value.teamId, value.projectId, value.agentClass, value.workdayId, value.nodeId, value.nodeRevision, value.graphRevision,
					JSON.stringify(value), JSON.stringify(result), JSON.stringify(value === review ? { activityCompletion: { reviewDisposition: 'approved' } } : {}), base.createdAt, base.createdAt, base.createdAt]);
		}
		await f.query(`INSERT INTO execution_edges (id,team_id,from_node_id,to_node_id,provenance,source_ref_json,graph_revision_created,created_at)
			VALUES ('producer-review',? ,?,?,'review-pair',?,1,?),('review-dependent',?, ?,?,'work-item',?,1,?)`,
			[base.teamId, actor.nodeId, review.nodeId, JSON.stringify(base.sourceRef), base.createdAt,
				base.teamId, review.nodeId, base.nodeId, JSON.stringify(base.sourceRef), base.createdAt]);
		const input = (value = facts.attempt) => ({ ...f.input(value), predecessorResults: [facts.actor, facts.review] });
		const snapshot = async () => {
			const state = await f.snapshot();
			return { ...state, financial: { ...state.financial,
				capacity_provider_assignments: (await f.query('SELECT * FROM capacity_provider_assignments ORDER BY id')).rows,
				capacity_reservations: (await f.query('SELECT * FROM capacity_reservations ORDER BY id')).rows,
				capacity_usage_actuals: (await f.query('SELECT * FROM capacity_usage_actuals ORDER BY id')).rows,
				capacity_ledger_entries: (await f.query('SELECT * FROM capacity_ledger_entries ORDER BY id')).rows },
				edges: (await f.query('SELECT * FROM execution_edges ORDER BY id')).rows };
		};
		return { ...f, ...facts, actorAttempt: actor, reviewAttempt: review, input, snapshot,
			admit: (value = input()) => admitLivingExecutionAssignment(f.store, value) };
	} catch (error) { await f.db.close(); throw error; }
}
