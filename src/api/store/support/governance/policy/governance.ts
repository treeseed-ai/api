import { createHash } from 'node:crypto';
import { arrayValue,parseJson,safeIdPart } from '../../index.ts';

export function governanceContentHash(input: any = {}) {
    const payload = {
        title: String(input.title ?? '').trim(),
        summary: String(input.summary ?? '').trim(),
        body: String(input.body ?? '').trim(),
        proposalType: String(input.proposalType ?? input.proposal_type ?? '').trim(),
        relatedObjectives: arrayValue(input.relatedObjectives ?? input.related_objectives).map(String).sort(),
        relatedQuestions: arrayValue(input.relatedQuestions ?? input.related_questions).map(String).sort(),
        relatedNotes: arrayValue(input.relatedNotes ?? input.related_notes).map(String).sort(),
        relatedBooks: arrayValue(input.relatedBooks ?? input.related_books).map(String).sort(),
        evidenceRefs: arrayValue(input.evidenceRefs ?? input.evidence_refs).map(String).sort(),
		decisionDependencies: arrayValue(input.decisionDependencies ?? input.decision_dependencies)
			.map((entry) => entry && typeof entry === 'object' ? entry : {})
			.map((entry: any) => ({ projectId: String(entry.projectId ?? entry.project_id ?? '').trim(), decisionId: String(entry.decisionId ?? entry.decision_id ?? '').trim() }))
			.sort((left, right) => `${left.projectId}:${left.decisionId}`.localeCompare(`${right.projectId}:${right.decisionId}`)),
        plan: input.plan ?? null,
        contentProvenance: input.contentProvenance ?? input.content_provenance ?? null,
    };
    return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

export function governanceSlug(value, fallback = 'proposal') {
    return safeIdPart(value, fallback).replace(/_+/gu, '-');
}

export function serializeGovernancePolicy(row) {
    if (!row)
        return null;
    return {
        id: row.id,
        teamId: row.team_id,
        projectId: row.project_id ?? null,
        scope: row.scope ?? 'team',
        providerId: row.provider_id,
        providerVersion: row.provider_version,
        config: parseJson(row.config_json, {}),
        active: Number(row.active ?? 1) === 1,
        createdBy: row.created_by ?? null,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        supersededAt: row.superseded_at ?? null,
    };
}

export function serializeGovernanceProposal(row) {
    if (!row)
        return null;
    return {
        id: row.id,
        teamId: row.team_id,
        projectId: row.project_id,
        scope: row.scope,
        status: row.status,
        title: row.title,
        summary: row.summary,
        body: row.body,
        proposalType: row.proposal_type,
        proposalTypes: parseJson(row.proposal_types_json, [row.proposal_type]).filter((value) => typeof value === 'string' && value),
        contentProposalSlug: row.content_proposal_slug,
        contentDecisionSlug: row.content_decision_slug,
        activeVersion: Number(row.active_version ?? 1),
        activeContentHash: row.active_content_hash,
        governanceProviderId: row.governance_provider_id,
        governanceProviderVersion: row.governance_provider_version,
        governancePolicyId: row.governance_policy_id,
        decisionId: row.decision_id,
        votingStartsAt: row.voting_starts_at,
        votingEndsAt: row.voting_ends_at,
        closedAt: row.closed_at,
        closedReason: row.closed_reason,
        createdByType: row.created_by_type,
        createdById: row.created_by_id,
        metadata: parseJson(row.metadata_json, {}),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

export function serializeGovernanceElectorateSnapshot(row) {
    if (!row)
        return null;
    return {
        id: row.id,
        proposalId: row.proposal_id,
        proposalVersion: Number(row.proposal_version ?? 1),
        providerId: row.provider_id,
        providerVersion: row.provider_version,
        ruleSnapshot: parseJson(row.rule_snapshot_json, {}),
        chambers: parseJson(row.chambers_json, []),
        eligibleVoters: parseJson(row.eligible_voters_json, []),
        delegations: parseJson(row.delegations_json, []),
        eligibleWeightTotal: Number(row.eligible_weight_total ?? 0),
        activeWeightTotal: Number(row.active_weight_total ?? 0),
        createdAt: row.created_at,
    };
}

export function serializeGovernanceVote(row) {
    if (!row)
        return null;
    return {
        id: row.id,
        proposalId: row.proposal_id,
        proposalVersion: Number(row.proposal_version ?? 1),
        userId: row.user_id,
        vote: row.vote,
        reason: row.reason,
        chamberVotes: parseJson(row.chamber_votes_json, {}),
        effectiveWeights: parseJson(row.effective_weights_json, {}),
        delegatedFrom: parseJson(row.delegated_from_json, []),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

export function serializeGovernanceDelegation(row) {
    if (!row)
        return null;
    return {
        id: row.id,
        teamId: row.team_id,
        scope: row.scope,
        fromUserId: row.from_user_id,
        toUserId: row.to_user_id,
        chambers: parseJson(row.chambers_json, []),
        status: row.status,
        reason: row.reason,
        createdAt: row.created_at,
        revokedAt: row.revoked_at,
        expiresAt: row.expires_at,
        metadata: parseJson(row.metadata_json, {}),
    };
}

export function serializeGovernanceDecision(row) {
    if (!row)
        return null;
    return {
        id: row.id,
        teamId: row.team_id,
        projectId: row.project_id,
        proposalId: row.proposal_id,
        proposalVersion: Number(row.proposal_version ?? 1),
        proposalContentHash: row.proposal_content_hash,
        status: row.status,
        title: row.title,
        summary: row.summary,
        contentDecisionSlug: row.content_decision_slug,
        governanceProviderId: row.governance_provider_id,
        governanceRule: parseJson(row.governance_rule_json, {}),
        electorateSnapshotId: row.electorate_snapshot_id,
        voteResult: parseJson(row.vote_result_json, {}),
        voterReasons: parseJson(row.voter_reasons_json, []),
        proposalSnapshot: parseJson(row.proposal_snapshot_json, {}),
        decisionRecord: parseJson(row.decision_record_json, {}),
        createdByType: row.created_by_type,
        createdById: row.created_by_id,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        supersededAt: row.superseded_at,
    };
}

export function serializeGovernanceEvent(row) {
    if (!row)
        return null;
    return {
        id: row.id,
        eventType: row.event_type,
        actorType: row.actor_type,
        actorId: row.actor_id,
        teamId: row.team_id,
        projectId: row.project_id,
        proposalId: row.proposal_id,
        decisionId: row.decision_id,
        proposalVersion: row.proposal_version == null ? null : Number(row.proposal_version),
        priorState: row.prior_state,
        nextState: row.next_state,
        message: row.message,
        evidence: parseJson(row.evidence_json, {}),
        createdAt: row.created_at,
    };
}
