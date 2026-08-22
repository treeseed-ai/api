export const EDITORIAL_REVIEW_KINDS = ['technical', 'audience', 'graph'] as const;
export const EDITORIAL_REVIEW_DISPOSITIONS = ['approved', 'changes-requested'] as const;

export type EditorialReviewKind = (typeof EDITORIAL_REVIEW_KINDS)[number];
export type EditorialReviewDisposition = (typeof EDITORIAL_REVIEW_DISPOSITIONS)[number];

export interface EditorialReviewCriterionResult {
	id: string;
	status: 'pass' | 'fail' | 'not-applicable';
	notes?: string;
}

export interface EditorialReviewResult {
	kind: EditorialReviewKind;
	disposition: EditorialReviewDisposition;
	reviewerId: string;
	authorId: string;
	contentRevision: string;
	contextDigest: string;
	criteria: EditorialReviewCriterionResult[];
	notes?: string;
}

export function validateEditorialReview(result: EditorialReviewResult) {
	if (!result || typeof result !== 'object') throw new Error('Editorial review result is required.');
	if (!EDITORIAL_REVIEW_KINDS.includes(result.kind)) throw new Error('Editorial review kind is invalid.');
	if (!EDITORIAL_REVIEW_DISPOSITIONS.includes(result.disposition)) throw new Error('Editorial review disposition is invalid.');
	if (!result.reviewerId?.trim() || !result.authorId?.trim()) throw new Error('Editorial reviews require reviewer and author identities.');
	if (result.reviewerId === result.authorId) throw new Error('Editorial authors cannot review their own work.');
	if (!result.contentRevision.trim() || !/^[a-f0-9]{64}$/u.test(result.contextDigest)) {
		throw new Error('Editorial reviews require an exact content revision and SHA-256 context digest.');
	}
	if (!result.criteria.length) throw new Error('Editorial reviews require structured criteria.');
	const criterionIds = new Set<string>();
	for (const criterion of result.criteria) {
		if (!criterion?.id?.trim() || !['pass', 'fail', 'not-applicable'].includes(criterion.status)) {
			throw new Error('Editorial review criteria require an id and valid status.');
		}
		if (criterionIds.has(criterion.id)) throw new Error(`Duplicate editorial review criterion "${criterion.id}".`);
		criterionIds.add(criterion.id);
	}
	if (result.disposition === 'approved' && result.criteria.some((criterion) => criterion.status === 'fail')) {
		throw new Error('An editorial review with failed criteria cannot be approved.');
	}
	return { ...result, criteria: result.criteria.map((criterion) => ({ ...criterion })) };
}
