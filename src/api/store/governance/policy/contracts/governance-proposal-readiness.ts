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
	const metadata = record(proposal.metadata);
	const participationSnapshot = record(metadata.participationSnapshot);
	const proposalVersion = Number(proposal.activeVersion ?? 0);
	const exactParticipation = Object.keys(participationSnapshot).length > 0;
	const events = await this.all(`SELECT id, actor_id, event_type, evidence_json FROM governance_events WHERE proposal_id = ? ORDER BY created_at ASC LIMIT 500`, [proposalId]);
	const resolved = new Set(events.map((row) => text(record(row.evidence_json).resolvesEventId)).filter(Boolean));
	const discussions = events.map((row) => ({ ...row, evidence: record(row.evidence_json) })).filter((row) => row.event_type === 'proposal.discussion');
	const blockers = discussions.filter((row) => ['question', 'concern'].includes(text(row.evidence.kind)) && !resolved.has(text(row.id)));
	const reviews = discussions.filter((row) => ['support', 'concern'].includes(text(row.evidence.kind)) && text(row.actor_id) !== text(proposal.createdById)
		&& (!exactParticipation || Number(row.evidence.proposalVersion) === proposalVersion));
	const modeRuns = proposal.projectId ? await this.all(`SELECT outputs_json FROM agent_mode_runs WHERE project_id = ? AND mode = 'planning' AND status = 'succeeded' ORDER BY created_at DESC LIMIT 500`, [proposal.projectId]) : [];
	const signals = await this.all(`SELECT contract_id,agent_id,workday_run_id,payload_json,metadata_json FROM agent_signals WHERE subject_kind = 'proposal' AND subject_id IN (?,?) ORDER BY created_at ASC LIMIT 500`, [proposalId, text(proposal.contentProposalSlug)]);
	const versionMatches = (value: Row) => !exactParticipation || Number(value.proposalVersion) === proposalVersion
		&& text(value.participationSnapshotDigest) === text(participationSnapshot.digest);
	const estimateSignals = signals.filter((row) => row.contract_id === 'proposal-estimated').map((row) => ({ ...record(row.payload_json), participant: text(record(row.payload_json).participant) || text(row.agent_id) })).filter(versionMatches);
	const reviewSignals = signals.filter((row) => row.contract_id === 'proposal-reviewed' && text(row.agent_id) !== text(proposal.createdById)).map((row) => ({ ...record(row.payload_json), agentId: text(row.agent_id), producerClass: text(record(row.metadata_json).producerClass) })).filter(versionMatches);
	const readySignals = signals.filter((row) => row.contract_id === 'proposal-ready').map((row) => ({ ...record(row.payload_json), participant: text(record(row.payload_json).participant) || text(row.agent_id) })).filter(versionMatches);
	const estimates = [...modeRuns.map((row) => structuredEstimate(row.outputs_json)), ...estimateSignals].filter((estimate) => (text(estimate.proposalId) === proposalId || text(estimate.proposalId) === text(proposal.contentProposalSlug)) && versionMatches(estimate));
	let proposalTypes: unknown = proposal.proposalTypes;
	if (!Array.isArray(proposalTypes)) try { proposalTypes = JSON.parse(String((proposal as Row).proposalTypesJson ?? (proposal as Row).proposal_types_json ?? '[]')); } catch { proposalTypes = []; }
	const estimatedParticipants = [...new Set(estimates.map((estimate) => text(estimate.participant,estimate.agentId)).filter(Boolean))];
	const completedParticipants = exactParticipation
		? [...new Set(readySignals.map((signal) => text(signal.participant)).filter(Boolean))]
		: estimatedParticipants;
	const requests = signals.filter((row) => row.contract_id === 'proposal-participant-requested').map((row) => ({ ...record(row.payload_json), workdayRunId: text(row.workday_run_id) }));
	const directParticipants = requests.filter((request) => text(request.targetKind) === 'agent').map((request) => text(request.targetId)).filter(Boolean);
	const classParticipants: string[] = [];
	for (const request of requests.filter((entry) => text(entry.targetKind) === 'class')) {
		const rows = await this.all(`SELECT DISTINCT participant.agent_id FROM workday_planning_participants participant JOIN workday_planning_sessions session ON session.id = participant.session_id WHERE session.workday_run_id = ? AND participant.project_agent_class_id = ?`, [request.workdayRunId, text(request.targetId)]);
		classParticipants.push(...rows.map((row) => text(row.agent_id)).filter(Boolean));
	}
	const requiredParticipants = [...new Set([...((metadata.requiredParticipantIds as string[] | undefined) ?? []), ...directParticipants, ...classParticipants])];
	const requiredReviewerClasses = Array.isArray(metadata.requiredReviewerClasses) ? metadata.requiredReviewerClasses.map(String) : [];
	const reviewedReviewerClasses = [...new Set(reviewSignals.map((review) => text(review.producerClass)).filter(Boolean))];
	return evaluateGovernanceProposalReadiness({
		title: proposal.title, summary: proposal.summary, body: proposal.body,
		relatedObjectives: metadata.relatedObjectives as string[], proposalTypes: proposalTypes as string[], evidenceRefs: metadata.evidenceRefs as string[], plan: metadata.plan,
		contentProvenance: metadata.contentProvenance, independentReviewCount: reviews.length + reviewSignals.length, estimateCount: estimates.length,
		unresolvedBlockerCount: blockers.length, requiresEstimate: false,
		requiredParticipantIds: requiredParticipants, estimatedParticipantIds: estimatedParticipants,
		requiredReviewerClasses, reviewedReviewerClasses,
		proposalVersion, participationSnapshot: exactParticipation ? participationSnapshot as unknown as Parameters<typeof evaluateGovernanceProposalReadiness>[0]['participationSnapshot'] : null,
		completedParticipantIds: completedParticipants,
		independentReviewerIds: [...reviews.map((review) => text(review.actor_id)),...reviewSignals.map((review) => text(review.agentId))].filter(Boolean),
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
