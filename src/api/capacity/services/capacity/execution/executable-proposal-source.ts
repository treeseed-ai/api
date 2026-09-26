import { createHash } from 'node:crypto';
import { CapacityOperationError } from '../../../../control-plane/repositories/capacity/capacity-operation-error.ts';
import { hasCompleteExecutablePlan, readExactProposal } from '../../../../governance/executable-proposal.ts';
import type { ExecutableProposalSource } from '../../../policy/execution/execution-graph-projector.ts';
import { loadProposalBlockingFeedback } from './proposal-planning-source.ts';

type Row = Record<string, unknown>;
const record = (value: unknown): Row => {
	if (value && typeof value === 'object' && !Array.isArray(value)) return value as Row;
	if (typeof value === 'string') try { return record(JSON.parse(value)); } catch { return {}; }
	return {};
};
const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
const stable = (value: unknown): string => {
	if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
	if (value && typeof value === 'object') return `{${Object.entries(value as Row).sort(([a], [b]) => a.localeCompare(b))
		.map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`;
	return JSON.stringify(value);
};

/** Load structurally complete drafts for review and accepted proposals for work. */
export async function loadTeamExecutableProposalSources(store: any, teamId: string, projectId?: string): Promise<ExecutableProposalSource[]> {
	const [rows, graphRows] = await Promise.all([store.all(`SELECT
			p.id AS proposal_id,p.project_id,p.active_version,p.active_content_hash,p.metadata_json,
			p.decision_id,d.id AS accepted_decision_id,d.proposal_version,d.proposal_content_hash,d.decision_record_json
		FROM governance_proposals p
		LEFT JOIN governance_decisions d ON d.id = p.decision_id AND d.proposal_id = p.id
			AND d.team_id = p.team_id AND d.status = 'accepted' AND d.superseded_at IS NULL
		WHERE p.team_id = ? AND ((p.decision_id IS NULL AND p.status IN ('draft','submitted','open','voting')) OR d.id IS NOT NULL)
			${projectId ? 'AND p.project_id = ?' : ''}
		ORDER BY p.project_id,p.id`, projectId ? [teamId, projectId] : [teamId]),
		store.all('SELECT source_ref_json,status FROM execution_nodes WHERE team_id=?', [teamId])]);
	const graphState = new Map<string, { count: number; incomplete: number }>();
	for (const graphRow of graphRows) {
		const source = record(graphRow.source_ref_json);
		if (text(source.model) !== 'proposal') continue;
		const key = `${text(source.id)}\u0000${text(source.digest)}`;
		const state = graphState.get(key) ?? { count: 0, incomplete: 0 };
		state.count += 1;
		if (text(graphRow.status) !== 'completed') state.incomplete += 1;
		graphState.set(key, state);
	}
	const sources: ExecutableProposalSource[] = [];
	for (const row of rows) {
		const accepted = Boolean(text(row.accepted_decision_id));
		const decisionRecord = record(row.decision_record_json);
		const recordedRef = record(decisionRecord.proposalRef);
		// Pre-cutover decisions remain governed history but never become demand.
		if (accepted && !text(recordedRef.id)) continue;
		// Once every node for the exact accepted revision is completed, the decision
		// remains governed history but no longer participates in the living graph.
		// Failed and cancelled nodes must remain demand so the projector can open the
		// bounded revision/re-review path instead of staling the accepted decision.
		// Reuse the graph itself as lifecycle authority; do not add an archive model.
		const state = graphState.get(`${text(row.proposal_id)}\u0000sha256:${text(row.active_content_hash)}`);
		if (accepted && state && state.count > 0 && state.incomplete === 0) continue;
		let exact;
		try { exact = await readExactProposal(store, { ...row, id: row.proposal_id }); }
		catch (error) {
			// An unaccepted, non-executable draft is governed history, not graph
			// demand. An accepted source must never disappear silently: doing so
			// would stale its existing graph nodes without a new decision.
			if (!accepted) continue;
			const value = error as { status?: number; code?: string };
			throw Object.assign(new CapacityOperationError(Number(value.status ?? 409), value.code ?? 'proposal_execution_plan_invalid',
				error instanceof Error ? error.message : 'The accepted proposal could not be read.'), { diagnostics: (error as { diagnostics?: unknown }).diagnostics });
		}
		if (!accepted && (!['draft', 'discussing', 'ready'].includes(text(exact.definition.status))
			|| !hasCompleteExecutablePlan(exact.definition))) continue;
		if (accepted && (exact.definition.status === 'withdrawn' || !hasCompleteExecutablePlan(exact.definition))) throw new CapacityOperationError(
			409, 'proposal_execution_plan_invalid', 'An accepted decision references an incomplete or withdrawn execution plan.');
		if (accepted && stable(recordedRef) !== stable(exact.ref)) throw new CapacityOperationError(
			409, 'proposal_decision_ref_stale', 'The accepted decision does not match the current exact proposal revision.');
		const selectedProjectId = text(row.project_id);
		sources.push({
			teamId, projectId: selectedProjectId, repository: exact.ref.repository!, path: exact.ref.path!, commit: exact.ref.commit!,
			digest: exact.ref.digest!, proposalRevision: Number(accepted ? row.proposal_version : row.active_version),
			frontmatter: exact.definition,
			feedback: await loadProposalBlockingFeedback(store, text(row.proposal_id)),
			decision: accepted ? {
				id: text(row.accepted_decision_id), revision: 1,
				digest: `sha256:${createHash('sha256').update(stable(decisionRecord)).digest('hex')}`,
				current: true,
			} : null,
		});
	}
	return sources;
}
