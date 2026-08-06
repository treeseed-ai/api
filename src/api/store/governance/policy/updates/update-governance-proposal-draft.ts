import { createHash,randomUUID } from 'node:crypto';
import { normalizeGovernanceProposalPlan } from '@treeseed/sdk';
import { governanceContentHash,isoNow,MarketControlPlaneStore,optionalStringValue } from "../../../../persistence/store.ts";
export async function updateGovernanceProposalDraftMethod(this: MarketControlPlaneStore, principal, proposalId, input: any = {}) {
    await this.ensureInitialized();
    const existing = await this.getGovernanceProposal(proposalId);
    if (!existing)
        return null;
    if (['accepted', 'rejected', 'withdrawn', 'superseded', 'no_decision_quorum_failed'].includes(existing.status)) {
        const error: Error & Record<string, any> = new Error('Closed proposals cannot be edited. Create a revised proposal instead.');
        error.status = 409;
        throw error;
    }
    const title = optionalStringValue(input.title, existing.title);
    const summary = optionalStringValue(input.summary, existing.summary);
    const body = optionalStringValue(input.body, existing.body);
    const proposalType = optionalStringValue(input.proposalType, existing.proposalType);
	const metadata = { ...(existing.metadata ?? {}), ...(input.metadata ?? {}) };
	const expectedVersion = Number(input.expectedProposalVersion);
	if (!Number.isInteger(expectedVersion) || expectedVersion !== existing.activeVersion) {
		const error: Error & Record<string, any> = new Error('The proposal changed after it was opened. Compare and rebase before publishing another version.'); error.status = 409; error.code = 'governance_proposal_version_stale'; error.currentVersion = existing.activeVersion; throw error;
	}
	const changeReason = optionalStringValue(input.changeReason);
	if (!changeReason) { const error: Error & Record<string, any> = new Error('A change summary is required to publish a proposal version.'); error.status = 422; error.code = 'governance_proposal_change_reason_required'; throw error; }
	const proposalTypes = [...new Set((Array.isArray(input.proposalTypes) ? input.proposalTypes : existing.proposalTypes ?? [proposalType]).map(String).map((value) => value.trim()).filter(Boolean))]; metadata.proposalTypes = proposalTypes;
    if (input.relatedObjectives !== undefined) metadata.relatedObjectives = input.relatedObjectives;
    if (input.evidenceRefs !== undefined) metadata.evidenceRefs = input.evidenceRefs;
    if (input.contentProvenance !== undefined) metadata.contentProvenance = input.contentProvenance;
    if (input.plan !== undefined) metadata.plan = normalizeGovernanceProposalPlan(input.plan);
    const nextHash = governanceContentHash({ title, summary, body, proposalType, ...metadata });
    const materialChange = nextHash !== existing.activeContentHash;
    const timestamp = isoNow();
	if (!materialChange && JSON.stringify(proposalTypes) === JSON.stringify(existing.proposalTypes ?? [existing.proposalType])) return existing;
	const nextVersion = existing.activeVersion + 1;
    const nextStatus = existing.status === 'voting' && materialChange ? 'open' : existing.status;
	await this.batch([{ query: `INSERT INTO governance_proposal_versions (
					id, proposal_id, version, title, summary, body, content_hash, change_reason,
					created_by_type, created_by_id, created_at
				) SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'user', ?, ? FROM governance_proposals WHERE id = ? AND active_version = ?`, params: [randomUUID(), proposalId, nextVersion, title, summary, body, nextHash, changeReason, principal?.id ?? null, timestamp, proposalId, expectedVersion] }, { query: `UPDATE governance_proposals
			 SET title = ?, summary = ?, body = ?, proposal_type = ?, proposal_types_json = ?, metadata_json = ?, status = ?, active_version = ?,
				 active_content_hash = ?, voting_starts_at = CASE WHEN ? = 1 THEN NULL ELSE voting_starts_at END,
				 voting_ends_at = CASE WHEN ? = 1 THEN NULL ELSE voting_ends_at END, updated_at = ?
			 WHERE id = ? AND active_version = ?`, params: [title, summary, body, proposalTypes[0] ?? proposalType, JSON.stringify(proposalTypes), JSON.stringify({ ...metadata, proposalTypes }), nextStatus, nextVersion, nextHash, existing.status === 'voting' ? 1 : 0, existing.status === 'voting' ? 1 : 0, timestamp, proposalId, expectedVersion] }]);
	const updated = await this.getGovernanceProposal(proposalId);
	if (!updated || updated.activeVersion !== nextVersion) { const error: Error & Record<string, any> = new Error('The proposal changed while the version was being published.'); error.status = 409; error.code = 'governance_proposal_version_stale'; error.currentVersion = updated?.activeVersion; throw error; }
	if (updated.projectId) {
		const signalId = `signal:proposal-version:${createHash('sha256').update(`${proposalId}:${nextVersion}:${nextHash}`).digest('hex')}`;
		const provenance = metadata.contentProvenance && typeof metadata.contentProvenance === 'object' ? metadata.contentProvenance as Record<string,unknown> : {};
		const commitSha = optionalStringValue(provenance.commitSha);
		const contentPath = optionalStringValue(provenance.contentPath);
		await this.run(`INSERT INTO agent_signals (id,contract_id,subject_kind,subject_id,team_id,project_id,workday_run_id,assignment_id,agent_id,activity_type,capacity_provider_id,causation_id,correlation_id,origin,commit_sha,immutable_ref,digest,changed_paths_json,change_summary,evidence_ref,payload_json,metadata_json,created_at) VALUES (?,'proposal-version-published','proposal',?,?,?,?,NULL,NULL,NULL,NULL,NULL,?,?,'deterministic-handler',?,?,?, ?,?,?,?, '{}',?) ON CONFLICT(id) DO NOTHING`, [signalId, proposalId, updated.teamId, updated.projectId, null, `proposal:${proposalId}:version:${nextVersion}`, `proposal:${proposalId}`, commitSha, commitSha, nextHash, JSON.stringify(contentPath ? [contentPath] : []), changeReason, `governance-proposal-version:${proposalId}:${nextVersion}`, JSON.stringify({ proposalId, version: nextVersion, proposalTypes, objectives: metadata.relatedObjectives ?? [], authorId: principal?.id ?? null }), timestamp]);
	}
    await this.recordGovernanceEvent({
		eventType: existing.status === 'voting' ? 'proposal.version_reset_voting' : 'proposal.version_published',
        actorType: 'user',
        actorId: principal?.id ?? null,
        teamId: existing.teamId,
        projectId: existing.projectId,
        proposalId,
        proposalVersion: nextVersion,
        priorState: existing.status,
        nextState: nextStatus,
        evidence: { priorHash: existing.activeContentHash, nextHash },
    });
	return updated;
}
