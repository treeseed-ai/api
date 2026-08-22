export const ARTIFACT_MUTATION_RECEIPT_SCHEMA = 'treeseed.artifact-mutation-receipt/v1' as const;

export type ArtifactMutationKind = 'treedx-content' | 'source-checkpoint';
export type ArtifactMutationPhase = 'provisional' | 'integrated';
import type { AgentWorkExecutionMode,UpstreamMutationPolicy } from '@treeseed/sdk/agent-capacity';

export interface ArtifactMutationEvidence {
	ref: string;
	digest?: string | null;
	artifactRefs: string[];
}

/** Portable proof that an assignment changed one governed artifact boundary. */
export interface ArtifactMutationReceipt {
	schemaVersion: typeof ARTIFACT_MUTATION_RECEIPT_SCHEMA;
	id: string;
	kind: ArtifactMutationKind;
	phase: ArtifactMutationPhase;
	executionMode: AgentWorkExecutionMode;
	upstreamMutationPolicy: UpstreamMutationPolicy;
	assignmentId: string;
	modeRunId: string;
	teamId: string;
	projectId: string;
	baseRef: string;
	effectiveRef: string;
	changedPaths: string[];
	before: ArtifactMutationEvidence;
	after: ArtifactMutationEvidence;
	review?: {
		reviewerId: string;
		disposition: 'approved' | 'rejected';
		evidenceReason: string;
		workdayId: string;
	};
	integration?: {
		actorId: string;
		targetRef: string;
		observedRef: string;
		observedPaths?: string[];
	};
	createdAt: string;
}

function exactRef(value: unknown): value is string {
	return typeof value === 'string' && value.trim().length > 0 && !/^(?:HEAD|main|master|staging|latest)$/iu.test(value.trim());
}

function digest(value: unknown) {
	return value == null || typeof value === 'string' && /^(?:sha256:)?[a-f0-9]{64}$/u.test(value);
}

export function validateArtifactMutationReceipt(value: unknown) {
	const receipt = value && typeof value === 'object' && !Array.isArray(value) ? value as Partial<ArtifactMutationReceipt> : {};
	const problems: string[] = [];
	if (receipt.schemaVersion !== ARTIFACT_MUTATION_RECEIPT_SCHEMA) problems.push('schemaVersion');
	for (const key of ['id', 'assignmentId', 'modeRunId', 'teamId', 'projectId'] as const) if (!exactRef(receipt[key])) problems.push(key);
	if (!['treedx-content', 'source-checkpoint'].includes(String(receipt.kind))) problems.push('kind');
	if (!['provisional', 'integrated'].includes(String(receipt.phase))) problems.push('phase');
	if (!['simulation', 'production'].includes(String(receipt.executionMode))) problems.push('executionMode');
	if (!['denied', 'checkpoint-only', 'exact-approved-ref'].includes(String(receipt.upstreamMutationPolicy))) problems.push('upstreamMutationPolicy');
	if (receipt.executionMode === 'simulation' && receipt.upstreamMutationPolicy !== 'denied') problems.push('upstreamMutationPolicy');
	if (receipt.phase === 'provisional' && receipt.upstreamMutationPolicy === 'exact-approved-ref') problems.push('upstreamMutationPolicy');
	if (receipt.phase === 'integrated' && receipt.executionMode === 'production' && receipt.upstreamMutationPolicy !== 'exact-approved-ref') problems.push('upstreamMutationPolicy');
	if (!exactRef(receipt.baseRef)) problems.push('baseRef');
	if (!exactRef(receipt.effectiveRef)) problems.push('effectiveRef');
	if (receipt.baseRef === receipt.effectiveRef) problems.push('effectiveRef');
	if (!Array.isArray(receipt.changedPaths) || !receipt.changedPaths.length || receipt.changedPaths.some((path) => typeof path !== 'string' || !path.trim())) problems.push('changedPaths');
	for (const key of ['before', 'after'] as const) {
		const evidence = receipt[key];
		if (!evidence || !exactRef(evidence.ref) || !Array.isArray(evidence.artifactRefs) || !digest(evidence.digest)) problems.push(key);
	}
	if (receipt.before?.ref !== receipt.baseRef) problems.push('before.ref');
	if (receipt.after?.ref !== receipt.effectiveRef) problems.push('after.ref');
	if (!receipt.createdAt || Number.isNaN(Date.parse(receipt.createdAt))) problems.push('createdAt');
	return problems.length
		? { ok: false as const, reason: `Artifact mutation receipt has invalid fields: ${[...new Set(problems)].join(', ')}.` }
		: { ok: true as const, value: receipt as ArtifactMutationReceipt };
}
