export interface GovernanceProposalPlan {
	desiredOutcome: string; currentProblem: string; proposedApproach: string;
	scope: string[]; nonGoals: string[]; deliverables: string[]; acceptanceCriteria: string[];
	risks: string[]; dependencies: string[]; alternatives: string[]; verification: string[]; openQuestions: string[];
}

export interface GovernanceProposalParticipationSnapshot {
	proposalVersion: number; planningGraphRevision: string; digest: string;
	groupIds: string[]; memberIds: string[]; authorAgentId: string;
}

export interface GovernanceProposalReadinessInput {
	title?: string; summary?: string; body?: string; relatedObjectives?: string[]; proposalTypes?: string[]; evidenceRefs?: string[];
	plan?: Partial<GovernanceProposalPlan> | null;
	contentProvenance?: { contentPath?: string; commitSha?: string; digest?: string; repositoryId?: string | null } | null;
	independentReviewCount?: number; estimateCount?: number; unresolvedBlockerCount?: number;
	requiredParticipantIds?: string[]; estimatedParticipantIds?: string[]; requiredReviewerClasses?: string[];
	reviewedReviewerClasses?: string[]; requiresEstimate?: boolean; proposalVersion?: number;
	participationSnapshot?: GovernanceProposalParticipationSnapshot | null; completedParticipantIds?: string[]; independentReviewerIds?: string[];
}

export interface GovernanceProposalReadiness {
	contentReady: boolean; votingReady: boolean; missingContent: string[]; missingVoting: string[];
	independentReviewCount: number; estimateCount: number; unresolvedBlockerCount: number;
	missingParticipantEstimates: string[]; missingReviewerClasses: string[]; participationVersionReady: boolean; authorIndependent: boolean;
}

function strings(value: unknown): string[] {
	return Array.isArray(value) ? [...new Set(value.filter((entry): entry is string => typeof entry === 'string').map((entry) => entry.trim()).filter(Boolean))] : [];
}

function substantive(value: unknown) { return typeof value === 'string' && value.trim().length >= 40; }

export function normalizeGovernanceProposalPlan(value: unknown): GovernanceProposalPlan {
	const input = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
	return {
		desiredOutcome: String(input.desiredOutcome ?? '').trim(), currentProblem: String(input.currentProblem ?? '').trim(),
		proposedApproach: String(input.proposedApproach ?? '').trim(), scope: strings(input.scope), nonGoals: strings(input.nonGoals),
		deliverables: strings(input.deliverables), acceptanceCriteria: strings(input.acceptanceCriteria), risks: strings(input.risks),
		dependencies: strings(input.dependencies), alternatives: strings(input.alternatives), verification: strings(input.verification),
		openQuestions: strings(input.openQuestions),
	};
}

export function evaluateGovernanceProposalReadiness(input: GovernanceProposalReadinessInput): GovernanceProposalReadiness {
	const plan = normalizeGovernanceProposalPlan(input.plan);
	const objectives = strings(input.relatedObjectives); const proposalTypes = strings(input.proposalTypes); const evidence = strings(input.evidenceRefs);
	const provenance = input.contentProvenance ?? {}; const missingContent: string[] = [];
	if (typeof input.title !== 'string' || input.title.trim().length < 8) missingContent.push('meaningful title');
	if (typeof input.summary !== 'string' || input.summary.trim().length < 40) missingContent.push('substantive summary');
	if (typeof input.body !== 'string' || input.body.trim().length < 100) missingContent.push('complete proposal text');
	if (!objectives.length) missingContent.push('related objective'); if (!proposalTypes.length) missingContent.push('proposal type');
	if (!substantive(plan.desiredOutcome)) missingContent.push('desired outcome'); if (!substantive(plan.currentProblem)) missingContent.push('current problem');
	if (!substantive(plan.proposedApproach)) missingContent.push('proposed approach');
	for (const [label, values] of [['scope', plan.scope], ['non-goals', plan.nonGoals], ['deliverables', plan.deliverables], ['acceptance criteria', plan.acceptanceCriteria], ['risks', plan.risks], ['alternatives', plan.alternatives], ['verification', plan.verification]] as const) if (!values.length) missingContent.push(label);
	if (!evidence.length) missingContent.push('research evidence');
	if (!provenance.contentPath || !provenance.commitSha || !provenance.digest) missingContent.push('immutable TreeDX provenance');
	const independentReviewCount = Math.max(0, Number(input.independentReviewCount ?? 0)); const estimateCount = Math.max(0, Number(input.estimateCount ?? 0));
	const unresolvedBlockerCount = Math.max(0, Number(input.unresolvedBlockerCount ?? 0)); const estimated = new Set(strings(input.estimatedParticipantIds));
	const snapshot = input.participationSnapshot; const requiredParticipants = snapshot?.memberIds?.length ? strings(snapshot.memberIds) : strings(input.requiredParticipantIds);
	const completedParticipants = new Set(strings(input.completedParticipantIds).length ? strings(input.completedParticipantIds) : [...estimated]);
	const missingParticipantEstimates = requiredParticipants.filter((id) => !completedParticipants.has(id));
	const participationVersionReady = !snapshot || snapshot.proposalVersion === input.proposalVersion;
	const independentReviewerIds = strings(input.independentReviewerIds).filter((id) => id !== snapshot?.authorAgentId); const authorIndependent = !snapshot || independentReviewerIds.length > 0;
	const reviewedClasses = new Set(strings(input.reviewedReviewerClasses)); const missingReviewerClasses = strings(input.requiredReviewerClasses).filter((id) => !reviewedClasses.has(id));
	const missingVoting = [...missingContent]; if (independentReviewCount < 1) missingVoting.push('independent review');
	if (input.requiresEstimate === true && estimateCount < 1) missingVoting.push('structured estimate');
	if (unresolvedBlockerCount > 0) missingVoting.push('resolved blocking questions and concerns');
	if (missingParticipantEstimates.length) missingVoting.push('estimate or not-applicable rationale from every participant');
	if (missingReviewerClasses.length) missingVoting.push('required proposal-type reviews'); if (!participationVersionReady) missingVoting.push('participation for the exact proposal version');
	if (!authorIndependent) missingVoting.push('author-independent group review');
	return { contentReady: missingContent.length === 0, votingReady: missingVoting.length === 0, missingContent, missingVoting, independentReviewCount, estimateCount, unresolvedBlockerCount, missingParticipantEstimates, missingReviewerClasses, participationVersionReady, authorIndependent };
}
