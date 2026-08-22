import { RESEARCH_WORKFLOW_STAGES,type ResearchClaim,type ResearchStageCompletion,type ResearchWorkflowNode,type ResearchWorkflowRecord,type ResearchWorkflowStage } from '@treeseed/sdk/agent-capacity';
import { validateResearchCitations } from './citation.ts';
import { validateResearchWorkflow } from './workflow-validation.ts';

const ROLES: Record<ResearchWorkflowStage, ResearchWorkflowNode['role']> = {
	'question-decomposition': 'researcher', 'source-selection-criteria': 'researcher', 'governed-source-search': 'researcher',
	'independent-source-fetch': 'researcher', 'linked-evidence-notes': 'researcher', 'claim-synthesis': 'researcher',
	'citation-review-rejection': 'reviewer', revision: 'researcher', 'citation-review-approval': 'reviewer',
	'cited-knowledge-publication': 'technical-writer', 'workday-report': 'reporter',
};

export function compileResearchWorkflow(input: { id: string; teamId: string; projectId: string; objectiveRef: string; questionRef: string; minimumIndependentSources?: number; maxRevisionCycles?: number; now?: string; metadata?: Record<string, unknown> }): ResearchWorkflowRecord {
	const now = input.now ?? new Date().toISOString();
	const nodes = RESEARCH_WORKFLOW_STAGES.map((stage, index): ResearchWorkflowNode => ({
		id: `${input.id}:${stage}`, stage, role: ROLES[stage], status: index === 0 ? 'ready' : 'pending',
		dependsOn: index ? [`${input.id}:${RESEARCH_WORKFLOW_STAGES[index - 1]}`] : [], artifactRefs: [],
	}));
	const workflow: ResearchWorkflowRecord = {
		schemaVersion: 1, id: input.id, teamId: input.teamId, projectId: input.projectId, objectiveRef: input.objectiveRef,
		questionRef: input.questionRef, status: 'ready', stateVersion: 1, minimumIndependentSources: input.minimumIndependentSources ?? 2,
		maxRevisionCycles: input.maxRevisionCycles ?? 3,
		nodes, citations: [], claims: [], reviewerRejectedUnsupportedClaims: false, reviewerApprovedRevision: false,
		revisionCount: 0, metadata: input.metadata, createdAt: now, updatedAt: now,
	};
	const validation = validateResearchWorkflow(workflow);
	if (!validation.ok) throw new Error(`Invalid research workflow: ${validation.diagnostics.map((item) => item.code).join(', ')}`);
	return workflow;
}

function independentPublishers(citations: ResearchWorkflowRecord['citations']) {
	return new Set(citations.map((citation) => new URL(citation.sourceUrl).hostname.toLowerCase())).size;
}

function materialClaimsHaveCitationEvidence(claims: ResearchClaim[], citations: ResearchWorkflowRecord['citations']) {
	return claims.filter((claim) => claim.material && claim.status !== 'unsupported')
		.every((claim) => claim.citationIds.length > 0 && citations.some((citation) => citation.claimIds.includes(claim.id)));
}

function appendReviewAttempt(workflow: ResearchWorkflowRecord, completion: ResearchStageCompletion, now: string) {
	const prior = Array.isArray(workflow.metadata?.reviewAttempts) ? workflow.metadata.reviewAttempts : [];
	return {
		...workflow.metadata,
		reviewAttempts: [...prior, {
			stage: completion.stage,
			assignmentId: completion.assignmentId,
			outcome: completion.reviewOutcome,
			reason: completion.reviewReason,
			artifactRefs: completion.artifactRefs,
			completedAt: now,
		}],
	};
}

export function advanceResearchWorkflow(workflow: ResearchWorkflowRecord, completion: ResearchStageCompletion, now = new Date().toISOString()): ResearchWorkflowRecord {
	if (completion.expectedStateVersion !== workflow.stateVersion) throw new Error('research_workflow_state_conflict');
	const index = workflow.nodes.findIndex((node) => node.stage === completion.stage);
	const node = workflow.nodes[index];
	if (!node || node.status !== 'ready') throw new Error('research_workflow_stage_not_ready');
	const citations = completion.citations ?? workflow.citations;
	const claims: ResearchClaim[] = completion.claims ?? workflow.claims;
	if (!validateResearchCitations(citations).ok) throw new Error('research_workflow_citations_invalid');
	if (completion.stage === 'independent-source-fetch' && independentPublishers(citations) < workflow.minimumIndependentSources) throw new Error('research_workflow_independent_sources_required');
	if (index > RESEARCH_WORKFLOW_STAGES.indexOf('independent-source-fetch') && independentPublishers(citations) < workflow.minimumIndependentSources) throw new Error('research_workflow_source_evidence_lost');
	if (completion.stage === 'linked-evidence-notes' && completion.artifactRefs.length < workflow.minimumIndependentSources) throw new Error('research_workflow_evidence_notes_required');
	if (completion.stage === 'claim-synthesis' && (!claims.length || !claims.some((claim) => claim.material && claim.status === 'unsupported'))) throw new Error('research_workflow_unsupported_claim_fixture_required');
	let reviewerRejected = workflow.reviewerRejectedUnsupportedClaims;
	let reviewerApproved = workflow.reviewerApprovedRevision;
	if (completion.stage === 'citation-review-rejection') {
		const unsupported = claims.some((claim) => claim.material && claim.status === 'unsupported');
		if (!unsupported || completion.reviewOutcome !== 'rejected' || !completion.reviewReason?.trim()) throw new Error('research_workflow_review_rejection_required');
		reviewerRejected = true;
	}
	if (completion.stage === 'revision' && (!reviewerRejected || claims.some((claim) => claim.material && claim.status === 'unsupported') || !materialClaimsHaveCitationEvidence(claims, citations))) throw new Error('research_workflow_revision_incomplete');
	if (completion.stage === 'citation-review-approval') {
		if (!reviewerRejected || claims.some((claim) => claim.material && claim.status === 'unsupported')) throw new Error('research_workflow_review_approval_required');
		if (completion.reviewOutcome === 'rejected') {
			if (!completion.reviewReason?.trim()) throw new Error('research_workflow_review_rejection_reason_required');
			if (workflow.revisionCount >= workflow.maxRevisionCycles) {
				const nodes = workflow.nodes.map((entry, nodeIndex) => nodeIndex === index
					? { ...entry, status: 'failed' as const, assignmentId: completion.assignmentId, artifactRefs: completion.artifactRefs, completedAt: now, metadata: { reviewReason: completion.reviewReason, revisionLimitReached: true } }
					: entry);
				const next: ResearchWorkflowRecord = {
					...workflow,
					nodes,
					citations,
					claims,
					reviewerApprovedRevision: false,
					metadata: {
						...appendReviewAttempt(workflow, completion, now),
						blockedCode: 'research_workflow_revision_limit_reached',
						blockedReason: completion.reviewReason,
						blockedAt: now,
					},
					status: 'blocked',
					stateVersion: workflow.stateVersion + 1,
					updatedAt: now,
				};
				const validation = validateResearchWorkflow(next);
				if (!validation.ok) throw new Error(`research_workflow_transition_invalid:${validation.diagnostics.map((item) => item.code).join(',')}`);
				return next;
			}
			const revisionIndex = workflow.nodes.findIndex((entry) => entry.stage === 'revision');
			const nodes = workflow.nodes.map((entry, nodeIndex) => nodeIndex === revisionIndex
				? { ...entry, status: 'ready' as const, assignmentId: null, artifactRefs: [], completedAt: null, metadata: { reopenedByReviewAssignmentId: completion.assignmentId, reviewReason: completion.reviewReason, reopenedAt: now } }
				: nodeIndex === index
					? { ...entry, status: 'pending' as const, assignmentId: null, artifactRefs: [], completedAt: null, metadata: { lastRejectedAssignmentId: completion.assignmentId, reviewReason: completion.reviewReason, rejectedAt: now } }
					: entry);
			const next: ResearchWorkflowRecord = {
				...workflow,
				nodes,
				citations,
				claims,
				reviewerApprovedRevision: false,
				metadata: appendReviewAttempt(workflow, completion, now),
				status: 'running',
				stateVersion: workflow.stateVersion + 1,
				updatedAt: now,
			};
			const validation = validateResearchWorkflow(next);
			if (!validation.ok) throw new Error(`research_workflow_transition_invalid:${validation.diagnostics.map((item) => item.code).join(',')}`);
			return next;
		}
		if (completion.reviewOutcome !== 'approved') throw new Error('research_workflow_review_approval_required');
		reviewerApproved = true;
	}
	if (completion.stage === 'cited-knowledge-publication' && (!reviewerApproved || !completion.publicationRef || claims.some((claim) => claim.material && claim.status === 'unsupported'))) throw new Error('research_workflow_publication_invalid');
	if (completion.stage === 'workday-report' && !completion.reportRef) throw new Error('research_workflow_report_required');
	const nodes = workflow.nodes.map((entry, nodeIndex) => nodeIndex === index
		? { ...entry, status: 'completed' as const, assignmentId: completion.assignmentId, artifactRefs: completion.artifactRefs, completedAt: now, metadata: completion.metadata }
		: nodeIndex === index + 1 ? { ...entry, status: 'ready' as const } : entry);
	const terminal = index === nodes.length - 1;
	const next: ResearchWorkflowRecord = {
		...workflow, nodes, citations, claims, reviewerRejectedUnsupportedClaims: reviewerRejected, reviewerApprovedRevision: reviewerApproved,
		revisionCount: workflow.revisionCount + (completion.stage === 'revision' ? 1 : 0),
		publicationRef: completion.publicationRef ?? workflow.publicationRef, reportRef: completion.reportRef ?? workflow.reportRef,
		metadata: completion.stage.startsWith('citation-review-') ? appendReviewAttempt(workflow, completion, now) : workflow.metadata,
		status: terminal ? 'completed' : 'running', stateVersion: workflow.stateVersion + 1, updatedAt: now,
	};
	const validation = validateResearchWorkflow(next);
	if (!validation.ok) throw new Error(`research_workflow_transition_invalid:${validation.diagnostics.map((item) => item.code).join(',')}`);
	return next;
}
