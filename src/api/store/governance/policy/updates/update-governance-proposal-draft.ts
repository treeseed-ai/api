import { createHash,randomUUID } from 'node:crypto';
import { decisionDependencyReferencesAreComplete,normalizeDecisionDependencyReferences,normalizeGovernanceProposalPlan } from '@treeseed/sdk';
import { governanceContentHash,isoNow,ControlPlaneStore,optionalStringValue } from "../../../../persistence/store.ts";
async function ensureVersionEvidence(store: ControlPlaneStore,input: { proposal:any;version:number;hash:string;metadata:Record<string,any>;proposalTypes:string[];changeReason:string;createdById:string|null;createdByType:string;priorState:string;nextState:string;priorHash:string }) {
	const timestamp=isoNow();const proposalId=String(input.proposal.id);
	if(input.proposal.projectId){const signalId=`signal:proposal-version:${createHash('sha256').update(`${proposalId}:${input.version}:${input.hash}`).digest('hex')}`;const provenance=input.metadata.contentProvenance&&typeof input.metadata.contentProvenance==='object'?input.metadata.contentProvenance:{};const commitSha=optionalStringValue(provenance.commitSha);const contentPath=optionalStringValue(provenance.contentPath);
		await store.run(`INSERT INTO agent_signals (id,contract_id,subject_kind,subject_id,team_id,project_id,workday_run_id,assignment_id,agent_id,activity_type,capacity_provider_id,causation_id,correlation_id,origin,commit_sha,immutable_ref,digest,changed_paths_json,change_summary,evidence_ref,payload_json,metadata_json,created_at) VALUES (?,'proposal-version-published','proposal',?,?,?,?,NULL,NULL,NULL,NULL,?,?,'deterministic-handler',?,?,?, ?,?,?,?, '{}',?) ON CONFLICT(id) DO NOTHING`,[signalId,proposalId,input.proposal.teamId,input.proposal.projectId,optionalStringValue(input.metadata.workdayRunId),`proposal:${proposalId}:version:${input.version}`,`proposal:${proposalId}`,commitSha,commitSha,input.hash,JSON.stringify(contentPath?[contentPath]:[]),input.changeReason,`governance-proposal-version:${proposalId}:${input.version}`,JSON.stringify({proposalId,version:input.version,proposalTypes:input.proposalTypes,objectives:input.metadata.relatedObjectives??[],authorId:input.createdById}),timestamp]);}
	const eventType=input.priorState==='voting'?'proposal.version_reset_voting':'proposal.version_published';
	const event=await store.first(`SELECT id FROM governance_events WHERE proposal_id = ? AND proposal_version = ? AND event_type = ? LIMIT 1`,[proposalId,input.version,eventType]);
	if(!event)await store.recordGovernanceEvent({eventType,actorType:input.createdByType,actorId:input.createdById,teamId:input.proposal.teamId,projectId:input.proposal.projectId,proposalId,proposalVersion:input.version,priorState:input.priorState,nextState:input.nextState,evidence:{priorHash:input.priorHash,nextHash:input.hash}});
}
export async function updateGovernanceProposalDraftMethod(this: ControlPlaneStore, principal, proposalId, input: any = {}) {
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
	const rawDecisionDependencies = input.decisionDependencies ?? input.metadata?.decisionDependencies ?? existing.metadata?.decisionDependencies ?? [];
	if (!decisionDependencyReferencesAreComplete(rawDecisionDependencies)) { const error: Error & Record<string, any> = new Error('Every decision dependency requires projectId and decisionId.'); error.status = 400; error.code = 'governance_decision_dependency_invalid'; throw error; }
	metadata.decisionDependencies = normalizeDecisionDependencyReferences(rawDecisionDependencies);
    if (input.contentProvenance !== undefined) metadata.contentProvenance = input.contentProvenance;
    if (input.plan !== undefined) metadata.plan = normalizeGovernanceProposalPlan(input.plan);
    const nextHash = governanceContentHash({ title, summary, body, proposalType, ...metadata });
    const materialChange = nextHash !== existing.activeContentHash;
    const timestamp = isoNow();
	const createdByType = optionalStringValue(input.createdByType,'user');
	const createdById = optionalStringValue(input.createdById,principal?.id ?? null);
	if (!materialChange && JSON.stringify(proposalTypes) === JSON.stringify(existing.proposalTypes ?? [existing.proposalType])) { await ensureVersionEvidence(this,{proposal:existing,version:existing.activeVersion,hash:existing.activeContentHash,metadata,proposalTypes,changeReason,createdById,createdByType,priorState:existing.status,nextState:existing.status,priorHash:existing.activeContentHash});return existing; }
	if(input.repairExistingVersion===true){const error:Error&Record<string,any>=new Error('The requested proposal update is a material revision and requires TreeDX authoring.');error.status=409;error.code='governance_proposal_repair_material_change';throw error;}
	const nextVersion = existing.activeVersion + 1;
	const nextStatus = existing.status === 'voting' && materialChange ? 'open' : existing.status;
	await this.batch([{ query: `INSERT INTO governance_proposal_versions (
					id, proposal_id, version, title, summary, body, content_hash, change_reason,
					created_by_type, created_by_id, created_at
				) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM governance_proposals WHERE id = ? AND active_version = ?`, params: [randomUUID(), proposalId, nextVersion, title, summary, body, nextHash, changeReason, createdByType, createdById, timestamp, proposalId, expectedVersion] }, { query: `UPDATE governance_proposals
			 SET title = ?, summary = ?, body = ?, proposal_type = ?, proposal_types_json = ?, metadata_json = ?, status = ?, active_version = ?,
				 active_content_hash = ?, voting_starts_at = CASE WHEN ? = 1 THEN NULL ELSE voting_starts_at END,
				 voting_ends_at = CASE WHEN ? = 1 THEN NULL ELSE voting_ends_at END, updated_at = ?
			 WHERE id = ? AND active_version = ?`, params: [title, summary, body, proposalTypes[0] ?? proposalType, JSON.stringify(proposalTypes), JSON.stringify({ ...metadata, proposalTypes }), nextStatus, nextVersion, nextHash, existing.status === 'voting' ? 1 : 0, existing.status === 'voting' ? 1 : 0, timestamp, proposalId, expectedVersion] }]);
	const updated = await this.getGovernanceProposal(proposalId);
	if (!updated || updated.activeVersion !== nextVersion) { const error: Error & Record<string, any> = new Error('The proposal changed while the version was being published.'); error.status = 409; error.code = 'governance_proposal_version_stale'; error.currentVersion = updated?.activeVersion; throw error; }
	await ensureVersionEvidence(this,{proposal:updated,version:nextVersion,hash:nextHash,metadata,proposalTypes,changeReason,createdById,createdByType,priorState:existing.status,nextState:nextStatus,priorHash:existing.activeContentHash});
	return updated;
}
