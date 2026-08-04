import { evaluateGovernanceProposalReadiness,type GovernanceProposalReadiness } from '@treeseed/sdk';
import type { MarketControlPlaneStore } from '../../../../persistence/store.ts';

type Row = Record<string, unknown>;
function record(value: unknown): Row { if (value && typeof value === 'object' && !Array.isArray(value)) return value as Row; if (typeof value === 'string') try { return record(JSON.parse(value)); } catch { return {}; } return {}; }
function text(value: unknown) { return typeof value === 'string' ? value.trim() : ''; }

function structuredEstimate(value: unknown) {
	const output = record(value); return record(record(output.metadata).structuredEstimate);
}

export async function governanceProposalReadinessMethod(this: MarketControlPlaneStore, proposalId: string): Promise<GovernanceProposalReadiness | null> {
	const proposal = await this.getGovernanceProposal(proposalId);
	if (!proposal) return null;
	const events = await this.all(`SELECT id, actor_id, event_type, evidence_json FROM governance_events WHERE proposal_id = ? ORDER BY created_at ASC LIMIT 500`, [proposalId]);
	const resolved = new Set(events.map((row) => text(record(row.evidence_json).resolvesEventId)).filter(Boolean));
	const discussions = events.map((row) => ({ ...row, evidence: record(row.evidence_json) })).filter((row) => row.event_type === 'proposal.discussion');
	const blockers = discussions.filter((row) => ['question', 'concern'].includes(text(row.evidence.kind)) && !resolved.has(text(row.id)));
	const reviews = discussions.filter((row) => ['support', 'concern'].includes(text(row.evidence.kind)) && text(row.actor_id) !== text(proposal.createdById));
	const modeRuns = proposal.projectId ? await this.all(`SELECT outputs_json FROM agent_mode_runs WHERE project_id = ? AND mode = 'planning' AND status = 'succeeded' ORDER BY created_at DESC LIMIT 500`, [proposal.projectId]) : [];
	const estimates = modeRuns.map((row) => structuredEstimate(row.outputs_json)).filter((estimate) => text(estimate.proposalId) === proposalId || text(estimate.proposalId) === text(proposal.contentProposalSlug));
	const metadata = record(proposal.metadata);
	return evaluateGovernanceProposalReadiness({
		title: proposal.title, summary: proposal.summary, body: proposal.body,
		relatedObjectives: metadata.relatedObjectives as string[], evidenceRefs: metadata.evidenceRefs as string[], plan: metadata.plan,
		contentProvenance: metadata.contentProvenance, independentReviewCount: reviews.length, estimateCount: estimates.length,
		unresolvedBlockerCount: blockers.length, requiresEstimate: ['implementation', 'editorial', 'structural'].includes(text(proposal.proposalType)),
	});
}

export async function assertGovernanceProposalReady(this: MarketControlPlaneStore, proposalId: string, stage: 'content' | 'voting') {
	const readiness = await governanceProposalReadinessMethod.call(this, proposalId);
	if (!readiness) return null;
	const missing = stage === 'content' ? readiness.missingContent : readiness.missingVoting;
	if (missing.length) {
		const error: Error & Record<string, unknown> = new Error(`Proposal is not ready for ${stage === 'content' ? 'discussion' : 'voting'}: ${missing.join(', ')}.`);
		error.status = 409; error.code = 'governance_proposal_not_ready'; error.readiness = readiness; throw error;
	}
	return readiness;
}
