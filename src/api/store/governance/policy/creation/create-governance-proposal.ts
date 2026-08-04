import { governanceVotingProvider,normalizeGovernanceProposalPlan } from '@treeseed/sdk';
import { randomUUID } from 'node:crypto';
import { COMMONS_TEAM_SLUG,governanceContentHash,governanceSlug,isoNow,MarketControlPlaneStore,optionalStringValue,stringValue } from "../../../../persistence/store.ts";
export async function createGovernanceProposalMethod(this: MarketControlPlaneStore, principal, input: any = {}) {
    await this.ensureInitialized();
    const title = stringValue(input.title);
    const summary = stringValue(input.summary);
    const body = stringValue(input.body);
    if (!title || !summary || !body) {
        const error: Error & Record<string, any> = new Error('Proposal title, summary, and body are required.');
        error.status = 400;
        throw error;
    }
    const project = input.projectId ? await this.getProject(input.projectId) : null;
    const teamId = input.teamId ?? project?.teamId ?? COMMONS_TEAM_SLUG;
    const scope = optionalStringValue(input.scope, project ? 'project' : 'commons');
    const policy = await this.resolveGovernancePolicy({ teamId, projectId: project?.id ?? null, scope });
    const provider = governanceVotingProvider(policy?.providerId);
    const timestamp = isoNow();
    const id = input.id ?? randomUUID();
    const proposalType = optionalStringValue(input.proposalType ?? input.decisionType, 'implementation');
    const metadata = { ...(input.metadata ?? {}), relatedObjectives: input.relatedObjectives ?? input.metadata?.relatedObjectives ?? [], evidenceRefs: input.evidenceRefs ?? input.metadata?.evidenceRefs ?? [], plan: normalizeGovernanceProposalPlan(input.plan ?? input.metadata?.plan), contentProvenance: input.contentProvenance ?? input.metadata?.contentProvenance ?? null };
    const contentHash = governanceContentHash({ title, summary, body, proposalType, ...metadata });
    const contentProposalSlug = optionalStringValue(input.contentProposalSlug) ?? governanceSlug(title, 'proposal');
    await this.run(`INSERT INTO governance_proposals (
				id, team_id, project_id, scope, status, title, summary, body, proposal_type,
				content_proposal_slug, content_decision_slug, active_version, active_content_hash,
				governance_provider_id, governance_provider_version, governance_policy_id, decision_id,
				voting_starts_at, voting_ends_at, closed_at, closed_reason, created_by_type, created_by_id,
				metadata_json, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?, ?, ?, ?)`, [
        id,
        teamId,
        project?.id ?? input.projectId ?? null,
        scope,
        input.status === 'open' || input.status === 'submitted' ? 'open' : 'draft',
        title,
        summary,
        body,
        proposalType,
        contentProposalSlug,
        contentHash,
        provider.id,
        provider.version,
        policy?.id ?? null,
        input.createdByType ?? 'user',
        input.createdById ?? principal?.id ?? null,
        JSON.stringify(metadata),
        timestamp,
        timestamp,
    ]);
    await this.run(`INSERT INTO governance_proposal_versions (
				id, proposal_id, version, title, summary, body, content_hash, change_reason,
				created_by_type, created_by_id, created_at
			) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`, [randomUUID(), id, title, summary, body, contentHash, 'Initial proposal version.', input.createdByType ?? 'user', input.createdById ?? principal?.id ?? null, timestamp]);
    await this.recordGovernanceEvent({
        eventType: 'proposal.created',
        actorType: input.createdByType ?? 'user',
        actorId: input.createdById ?? principal?.id ?? null,
        teamId,
        projectId: project?.id ?? input.projectId ?? null,
        proposalId: id,
        proposalVersion: 1,
        nextState: input.status === 'open' || input.status === 'submitted' ? 'open' : 'draft',
        evidence: { providerId: provider.id, policyId: policy?.id ?? null },
    });
    return this.getGovernanceProposal(id);
}
