import { randomUUID } from 'node:crypto';
import { isoNow,ControlPlaneStore,serializeGovernanceDecision } from "../../../../persistence/store.ts";
import { resolveDecisionDependencySnapshots, validateDecisionAuthority } from '../../../../governance/decision-authority.ts';
import { reconcileExecutionGraph } from '../../../../control-plane/repositories/capacity/execution/execution-graph-service.ts';
import { hasCompleteExecutablePlan, publishProposalDecision, readExactProposal } from '../../../../governance/executable-proposal.ts';
export async function createGovernanceDecisionFromProposalMethod(this: ControlPlaneStore, proposalId: string, input: any = {}) {
    await this.ensureInitialized();
    const proposal = await this.getGovernanceProposal(proposalId);
    if (!proposal)
        return null;
    const existing = await this.first(`SELECT * FROM governance_decisions WHERE proposal_id = ? LIMIT 1`, [proposalId]);
    if (existing?.id && existing.status !== 'creating') {
        const validation = await validateDecisionAuthority(this, String(existing.id), {
            teamId: proposal.teamId, projectId: proposal.projectId,
        });
        if (!validation.valid) throw Object.assign(new Error(validation.message ?? 'The retained decision authority is not current.'), {
            status: 409, code: validation.code,
        });
        return serializeGovernanceDecision(existing);
    }
    if (proposal.status !== 'accepted') throw Object.assign(new Error('Only an accepted proposal can publish execution authority.'), { status: 409, code: 'governance_proposal_not_accepted' });
    if (existing && (existing.team_id !== proposal.teamId || existing.project_id !== proposal.projectId
        || Number(existing.proposal_version) !== proposal.activeVersion || existing.proposal_content_hash !== proposal.activeContentHash || existing.superseded_at)) {
        throw Object.assign(new Error('The reserved Decision no longer matches its proposal authority.'), { status: 409, code: 'governance_decision_proposal_stale' });
    }
    const timestamp = existing?.created_at ?? isoNow();
    const id = existing?.id ?? randomUUID();
    const votes = await this.effectiveGovernanceVotes(proposal) as Array<{
        userId: string;
        vote: string;
        reason?: string | null;
    }>;
    const voterReasons = votes.filter((vote) => vote.reason).map((vote) => ({ userId: vote.userId, vote: vote.vote, reason: vote.reason }));
    const proposalSnapshot = {
        title: proposal.title,
        summary: proposal.summary,
        body: proposal.body,
        proposalType: proposal.proposalType,
        contentHash: proposal.activeContentHash,
        version: proposal.activeVersion,
    };
	const dependencyResult = await resolveDecisionDependencySnapshots(this, proposal.teamId, proposal.metadata?.decisionDependencies ?? []);
	if (!dependencyResult.ok) {
		const error: Error & Record<string, any> = new Error(`Decision dependency ${dependencyResult.reference.decisionId} is not current: ${dependencyResult.validation.message}`);
		error.status = 409; error.code = dependencyResult.validation.code; error.details = { dependency: dependencyResult.reference }; throw error;
	}
	const exact = await readExactProposal(this, proposal);
	if (exact.definition.status === 'withdrawn' || !hasCompleteExecutablePlan(exact.definition)) {
		const error: Error & Record<string, any> = new Error('An accepted decision requires one complete proposal-owned execution plan.');
		error.status = 409; error.code = 'governance_decision_execution_plan_required'; throw error;
	}
	const proposalRef = exact.ref;
	const decisionRecord = existing ? JSON.parse(String(existing.decision_record_json)) : { decisionDependencies: dependencyResult.dependencies, proposalRef,
        rationale: input.reason ?? proposal.closedReason };
    if (!existing) await this.run(`INSERT INTO governance_decisions (
				id, team_id, project_id, proposal_id, proposal_version, proposal_content_hash, status,
				title, summary, content_decision_slug, governance_provider_id, governance_rule_json,
				electorate_snapshot_id, vote_result_json, voter_reasons_json, proposal_snapshot_json,
				decision_record_json, created_by_type, created_by_id, created_at, updated_at, superseded_at
			) VALUES (?, ?, ?, ?, ?, ?, 'creating', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
            ON CONFLICT (proposal_id) DO NOTHING`, [
        id,
        proposal.teamId,
        proposal.projectId,
        proposal.id,
        proposal.activeVersion,
        proposal.activeContentHash,
        proposal.title,
        proposal.summary,
        proposal.contentDecisionSlug,
        proposal.governanceProviderId,
        JSON.stringify(input.outcome?.voteResult?.chambers ? { providerId: proposal.governanceProviderId } : {}),
        input.electorateSnapshotId ?? null,
        JSON.stringify(input.outcome?.voteResult ?? {}),
        JSON.stringify(voterReasons),
		JSON.stringify({ ...proposalSnapshot, decisionDependencies: dependencyResult.dependencies, proposalRef }),
		JSON.stringify(decisionRecord),
        input.actorType ?? 'system',
        input.actorId ?? null,
        timestamp,
        timestamp,
    ]);
    const reserved = await this.first('SELECT * FROM governance_decisions WHERE proposal_id = ? LIMIT 1', [proposalId]);
    if (!reserved) throw new Error('Decision reservation did not persist.');
    if (reserved.id !== id || reserved.status !== 'creating') return this.createGovernanceDecisionFromProposal(proposalId, input);
    const decisionRef = await publishProposalDecision(this, proposal, reserved, votes);
    // The native commit survives an interrupted SQL projection. Neither an
    // accepted row nor its proposal link may escape without the same event.
    await this.batch([
        { query: `UPDATE governance_decisions SET status='accepted',decision_record_json=?,updated_at=? WHERE id=? AND status='creating'
            AND EXISTS (SELECT 1 FROM governance_proposals WHERE id=? AND status='accepted' AND active_version=? AND active_content_hash=?)`,
            params: [JSON.stringify({ ...decisionRecord, decisionRef }), timestamp, id, proposal.id, proposal.activeVersion, proposal.activeContentHash] },
        { query: `UPDATE governance_proposals SET decision_id=?,updated_at=? WHERE id=? AND status='accepted' AND active_version=? AND active_content_hash=?
            AND EXISTS (SELECT 1 FROM governance_decisions WHERE id=? AND status='accepted' AND superseded_at IS NULL)`,
            params: [id, timestamp, proposal.id, proposal.activeVersion, proposal.activeContentHash, id] },
        { query: `INSERT INTO governance_events (id,event_type,actor_type,actor_id,team_id,project_id,proposal_id,decision_id,
            proposal_version,next_state,evidence_json,created_at)
            SELECT ?, 'decision.created',created_by_type,created_by_id,team_id,project_id,proposal_id,id,proposal_version,'accepted',?,created_at
            FROM governance_decisions WHERE id=? AND status='accepted' AND superseded_at IS NULL
            ON CONFLICT (id) DO NOTHING`,
            params: [`decision-created:${id}`, JSON.stringify({ proposalContentHash: proposal.activeContentHash }), id] },
    ]);
    const validation = await validateDecisionAuthority(this, String(id), { teamId: proposal.teamId, projectId: proposal.projectId });
    if (!validation.valid) throw Object.assign(new Error(validation.message ?? 'Decision projection lost its proposal authority.'), { status: 409, code: validation.code });
	await reconcileExecutionGraph(this, proposal.teamId, { projectId: proposal.projectId }, `decision:${id}:${proposal.activeVersion}`);
    return this.getGovernanceDecision(id);
}
