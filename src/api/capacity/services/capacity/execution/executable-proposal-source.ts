import { createHash } from 'node:crypto';
import { CapacityOperationError } from '../../../../control-plane/repositories/capacity/capacity-operation-error.ts';
import { readExactProposal } from '../../../../governance/executable-proposal.ts';
import type { ExecutableProposalSource } from '../../../policy/execution/execution-graph-projector.ts';

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

/** Load ready proposals for governance review and accepted proposals for work. */
export async function loadTeamExecutableProposalSources(store: any, teamId: string, projectId?: string): Promise<ExecutableProposalSource[]> {
	const rows = await store.all(`SELECT
			p.id AS proposal_id,p.project_id,p.active_version,p.active_content_hash,p.metadata_json,
			p.decision_id,d.id AS accepted_decision_id,d.proposal_version,d.proposal_content_hash,d.decision_record_json
		FROM governance_proposals p
		LEFT JOIN governance_decisions d ON d.id = p.decision_id AND d.proposal_id = p.id
			AND d.team_id = p.team_id AND d.status = 'accepted' AND d.superseded_at IS NULL
		WHERE p.team_id = ? AND (p.decision_id IS NULL OR d.id IS NOT NULL)
			${projectId ? 'AND p.project_id = ?' : ''}
		ORDER BY p.project_id,p.id`, projectId ? [teamId, projectId] : [teamId]);
	const sources: ExecutableProposalSource[] = [];
	for (const row of rows) {
		const accepted = Boolean(text(row.accepted_decision_id));
		const decisionRecord = record(row.decision_record_json);
		const recordedRef = record(decisionRecord.proposalRef);
		// Pre-cutover decisions remain governed history but never become demand.
		if (accepted && !text(recordedRef.id)) continue;
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
		if (!accepted && exact.definition.status !== 'ready') continue;
		if (accepted && exact.definition.status !== 'ready' && exact.definition.status !== 'decided') throw new CapacityOperationError(
			409, 'proposal_execution_status_invalid', 'An accepted decision references a proposal that was not ready for execution.');
		if (accepted && stable(recordedRef) !== stable(exact.ref)) throw new CapacityOperationError(
			409, 'proposal_decision_ref_stale', 'The accepted decision does not match the current exact proposal revision.');
		const selectedProjectId = text(row.project_id);
		sources.push({
			teamId, projectId: selectedProjectId, repository: exact.ref.repository!, path: exact.ref.path!, commit: exact.ref.commit!,
			digest: exact.ref.digest!, proposalRevision: Number(accepted ? row.proposal_version : row.active_version),
			frontmatter: exact.definition,
			decision: accepted ? {
				id: text(row.accepted_decision_id), revision: 1,
				digest: `sha256:${createHash('sha256').update(stable(decisionRecord)).digest('hex')}`,
				current: true,
			} : null,
		});
	}
	return sources;
}
