type Row = Record<string, unknown>;

export type SemanticArtifactExpectation = {
	id: string;
	agentId: string;
	activityType: string;
	model: string;
	pathPrefix: string;
	subjectRefs: string[];
	relationFields: string[];
	requiredClaims: string[];
};

const record = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';

export function semanticArtifactChecks(artifact: Row, expectation: SemanticArtifactExpectation) {
	const path = text(artifact.contentPath || artifact.path);
	const frontmatter = record(artifact.frontmatter);
	const searchableRelations = JSON.stringify({ frontmatter, subjectId: artifact.subjectId });
	const content = text(artifact.content || artifact.body).toLowerCase();
	return {
		model: text(artifact.model) === expectation.model,
		path: path.startsWith(expectation.pathPrefix),
		commit: /^[a-f0-9]{40}$/u.test(text(artifact.commitSha || artifact.ref)),
		readBack: !artifact.inspectionError,
		subjects: expectation.subjectRefs.every((subject) => searchableRelations.includes(subject)),
		relations: expectation.relationFields.every((field) => {
			const value = frontmatter[field];
			return Array.isArray(value) ? value.length > 0 : Boolean(text(value));
		}),
		claims: expectation.requiredClaims.every((claim) => content.includes(claim.toLowerCase())),
	};
}
