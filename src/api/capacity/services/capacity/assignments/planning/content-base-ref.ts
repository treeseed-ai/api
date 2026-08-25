import { CapacityGovernanceError } from '../../../../database.ts';

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

function text(value: unknown, fallback = ''): string {
	return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function immutableCommit(value: unknown): string {
	const candidate = text(value);
	return /^[0-9a-f]{40}$/iu.test(candidate) ? candidate : '';
}

function proposalVersion(value: unknown): string {
	const artifact = record(value);
	return text(artifact.model) === 'proposal' ? immutableCommit(artifact.version) : '';
}

function signalProposalVersions(intent: JsonRecord): string[] {
	const upstreamEvidence = Array.isArray(intent.upstreamEvidence) ? intent.upstreamEvidence : [];
	return upstreamEvidence.flatMap((candidate) => {
		const payload = record(record(candidate).payload);
		const refs = Array.isArray(payload.evidenceRefs) ? payload.evidenceRefs : [];
		const exactRefs = refs.map(proposalVersion).filter(Boolean);
		const identity = record(payload.durableSubjectIdentity);
		const identityVersion = text(identity.subjectKind) === 'proposal'
			? immutableCommit(identity.version)
			: '';
		const routedVersion = text(payload.proposalId).startsWith('proposal:')
			? immutableCommit(payload.version)
			: '';
		return [...exactRefs, identityVersion, routedVersion].filter(Boolean);
	});
}

export function resolveAssignmentContentBaseRef(payload: JsonRecord): string {
	const intent = record(payload.intent);
	const relatedArtifact = record(intent.relatedArtifact);
	const relatedArtifacts = Array.isArray(intent.relatedArtifacts)
		? intent.relatedArtifacts.map(record)
		: [];
	const versions = [
		proposalVersion(relatedArtifact),
		...relatedArtifacts.map(proposalVersion),
		...signalProposalVersions(intent),
	].filter(Boolean);
	const uniqueVersions = [...new Set(versions)];
	if (uniqueVersions.length > 1) {
		throw new CapacityGovernanceError(
			'capacity_workday_proposal_version_conflict',
			'Assignment evidence references conflicting immutable proposal versions.',
			409,
			{ versions: uniqueVersions },
		);
	}
	if (uniqueVersions[0]) return uniqueVersions[0];
	return text(
		relatedArtifact.commitSha,
		text(
			relatedArtifacts.find((artifact) => text(artifact.commitSha))?.commitSha,
			text(payload.contentBaseRef, 'refs/heads/main'),
		),
	);
}
