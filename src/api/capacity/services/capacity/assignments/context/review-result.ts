import { assignmentResultSchema } from '@treeseed/sdk/agent-capacity';
import { createHash } from 'node:crypto';
import { validatePortableContentData } from '@treeseed/sdk/content-validation';
import { CapacityGovernanceError, type CapacityGovernanceDatabase } from '../../../../database.ts';
import type { DurableProviderAssignment } from '../../../../repositories/capacity/assignments/assignment.ts';
import { resolveKnowledgeGatewayConnection } from '../../../../../knowledge/gateway-treedx-connection.ts';

type Row = Record<string, unknown>;
const record = (value: unknown): Row => {
	if (typeof value === 'string') try { return record(JSON.parse(value)); } catch { return {}; }
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
};
const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';
const stable = (value: unknown): string => {
	if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
	if (value && typeof value === 'object') return `{${Object.entries(value as Row).sort(([a], [b]) => a.localeCompare(b))
		.map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`;
	return JSON.stringify(value);
};

function sameCandidate(subject: Row, candidate: Row): boolean {
	if (subject.store !== (candidate.kind ?? candidate.store) || subject.repository !== candidate.repository || subject.commit !== candidate.commit) return false;
	return !candidate.path || subject.path === candidate.path;
}

/** Resolve a Reviewer disposition only from a classed decision at an exact TreeDX commit. */
export async function resolveReviewDisposition(store: CapacityGovernanceDatabase, assignment: DurableProviderAssignment,
	result: ReturnType<typeof assignmentResultSchema.parse>,
	readDecision: (reference: Extract<ReturnType<typeof assignmentResultSchema.parse>['references'][number], { kind: 'treedx' }>) => Promise<Row | null> = async (reference) => {
		const connection = await resolveKnowledgeGatewayConnection(store, {
			projectId: assignment.projectId, write: false, relationPaths: true, readRefs: [reference.commit],
		});
		if (!connection || connection.repositoryId !== reference.repository) return null;
		const response = record(await connection.client.readRepositoryFile({ repoId: reference.repository,
			ref: reference.commit, path: reference.path, encoding: 'utf8', parseFrontmatter: true, allowProtected: true }));
		if (text(response.resolvedRef) !== reference.commit) return null;
		const file = record(response.file ?? (Array.isArray(response.files) ? response.files[0] : null));
		return record(file.frontmatter);
	},
): Promise<'approved' | 'request-changes' | null> {
	const node = assignment.executionNodeId ? await store.first(
		`SELECT pair_role FROM execution_nodes WHERE team_id=? AND id=? AND node_revision=? LIMIT 1`,
		[assignment.teamId, assignment.executionNodeId, assignment.executionNodeRevision],
	) : null;
	if (text(node?.pair_role) !== 'reviewer') return null;
	const predecessorRows = await store.all(`SELECT completed.assignment_result_json,actor.workspace,actor.source_ref_json
		FROM execution_edges edge
		JOIN execution_nodes actor ON actor.team_id=edge.team_id AND actor.id=edge.from_node_id AND actor.pair_role='actor'
	JOIN LATERAL (
			SELECT assignment_result_json FROM capacity_provider_assignments candidate
			WHERE candidate.team_id=edge.team_id AND candidate.execution_node_id=actor.id
				AND candidate.status='completed' AND candidate.assignment_result_json IS NOT NULL
				${assignment.executionMode === 'simulation' && assignment.workDayId ? 'AND candidate.work_day_id=?' : ''}
				AND candidate.completed_at<=?
			ORDER BY candidate.execution_node_revision DESC,candidate.completed_at DESC,candidate.id DESC LIMIT 1
		) completed ON true
		WHERE edge.team_id=? AND edge.to_node_id=? AND edge.provenance='review-pair'
			AND edge.graph_revision_removed IS NULL`, [...(assignment.executionMode === 'simulation' && assignment.workDayId ? [assignment.workDayId] : []), assignment.assignedAt ?? assignment.createdAt,
			assignment.teamId, assignment.executionNodeId]);
	const expected = new Set(assignment.assignmentAttempt?.predecessorResultIds ?? []);
	const candidates = predecessorRows.flatMap((row) => {
		const parsed = assignmentResultSchema.safeParse(record(row.assignment_result_json));
		if (parsed.success && expected.size && !expected.has(parsed.data.id)) return [];
		const references = parsed.success ? parsed.data.references.filter((reference) => reference.kind !== 'url') : [];
		return references.length > 0 ? references : text(row.workspace) === 'read-only' ? [record(row.source_ref_json)] : [];
	});
	if (!candidates.length) throw new CapacityGovernanceError('review_candidate_reference_missing',
		'Reviewer completion requires the exact immutable actor candidate.', 409, { assignmentId: assignment.id });
	const decisions = result.references.filter((reference) => reference.kind === 'treedx');
	for (const reference of decisions) {
		const parsed = validatePortableContentData('decision', await readDecision(reference));
		if (!parsed.ok) continue;
		const decision = record(parsed.data);
		if (decision.decisionClass !== 'work-review' || decision.projectId !== assignment.projectId
			|| !candidates.some((candidate) => sameCandidate(record(decision.subjectRef), record(candidate)))) continue;
		return decision.disposition === 'approved' ? 'approved' : 'request-changes';
	}
	throw new CapacityGovernanceError('review_decision_required',
		'Reviewer completion requires an exact work-review decision bound to the actor candidate.', 409,
		{ assignmentId: assignment.id });
}

export interface ProposalReviewResolution {
	disposition: 'approved' | 'rejected' | 'deferred';
	reference: Extract<ReturnType<typeof assignmentResultSchema.parse>['references'][number], { kind: 'treedx' }>;
	sourceRef: { store: 'treedx'; model: 'decision'; id: string; revision: number; digest: string;
		repository: string; commit: string; path: string };
}

/** Validate proposal-review output without turning it into acting-work review. */
export async function resolveProposalReviewDisposition(store: CapacityGovernanceDatabase, assignment: DurableProviderAssignment,
	result: ReturnType<typeof assignmentResultSchema.parse>,
	readDecision: (reference: Extract<ReturnType<typeof assignmentResultSchema.parse>['references'][number], { kind: 'treedx' }>) => Promise<{ frontmatter: Row; source: string } | null> = async (reference) => {
		const connection = await resolveKnowledgeGatewayConnection(store, {
			projectId: assignment.projectId, write: false, relationPaths: true, readRefs: [reference.commit],
		});
		if (!connection || connection.repositoryId !== reference.repository) return null;
		const response = record(await connection.client.readRepositoryFile({ repoId: reference.repository,
			ref: reference.commit, path: reference.path, encoding: 'utf8', parseFrontmatter: true, allowProtected: true }));
		if (text(response.resolvedRef) !== reference.commit) return null;
		const file = record(response.file ?? (Array.isArray(response.files) ? response.files[0] : null));
		return typeof file.content === 'string' ? { frontmatter: record(file.frontmatter), source: file.content } : null;
	},
): Promise<ProposalReviewResolution | null> {
	const node = assignment.executionNodeId ? await store.first(
		`SELECT kind,pair_role,source_ref_json FROM execution_nodes WHERE team_id=? AND id=? AND node_revision=? LIMIT 1`,
		[assignment.teamId, assignment.executionNodeId, assignment.executionNodeRevision],
	) : null;
	if (text(node?.kind) !== 'reviewing' || node?.pair_role != null) return null;
	const sourceRef = record(node?.source_ref_json);
	for (const reference of result.references.filter((candidate) => candidate.kind === 'treedx')) {
		const content = await readDecision(reference);
		if (!content) continue;
		const parsed = validatePortableContentData('decision', content.frontmatter);
		if (!parsed.ok) continue;
		const decision = record(parsed.data);
		if (decision.decisionClass !== 'proposal' || decision.projectId !== assignment.projectId
			|| stable(record(decision.subjectRef)) !== stable(sourceRef)
			|| !['approved', 'rejected', 'deferred'].includes(text(decision.disposition))) continue;
		return { disposition: decision.disposition as ProposalReviewResolution['disposition'], reference,
			sourceRef: { store: 'treedx', model: 'decision', id: text(decision.id), revision: 1,
				digest: `sha256:${createHash('sha256').update(content.source).digest('hex')}`,
				repository: reference.repository, commit: reference.commit, path: reference.path } };
	}
	throw new CapacityGovernanceError('proposal_review_decision_required',
		'Reviewer completion requires one proposal decision bound to the exact proposal source.', 409,
		{ assignmentId: assignment.id });
}
