export const WORK_CONTENT_COLLECTIONS = ['objectives', 'questions', 'notes', 'proposals', 'decisions'];

export const WORK_CONTENT_LABELS = {
	objectives: { singular: 'objective', plural: 'objectives', title: 'Objective' },
	questions: { singular: 'question', plural: 'questions', title: 'Question' },
	notes: { singular: 'note', plural: 'notes', title: 'Note' },
	proposals: { singular: 'proposal', plural: 'proposals', title: 'Proposal' },
	decisions: { singular: 'decision', plural: 'decisions', title: 'Decision' },
};

export const RELATION_FIELD_BY_COLLECTION = {
	objectives: 'relatedObjectives',
	questions: 'relatedQuestions',
	notes: 'relatedNotes',
	proposals: 'relatedProposals',
	decisions: null,
};

const CONTENT_RELATION_POLICIES = {
	objectives: {
		questions: { sourceField: 'relatedQuestions', targetField: 'relatedObjectives' },
	},
	questions: {
		objectives: { sourceField: 'relatedObjectives', targetField: 'relatedQuestions' },
	},
	notes: {
		objectives: { sourceField: 'relatedObjectives' },
		questions: { sourceField: 'relatedQuestions' },
		proposals: { sourceField: 'relatedProposals', targetField: 'relatedNotes' },
	},
	proposals: {
		objectives: { sourceField: 'relatedObjectives' },
		questions: { sourceField: 'relatedQuestions' },
		notes: { sourceField: 'relatedNotes', targetField: 'relatedProposals' },
		decisions: { sourceField: 'decision', targetField: 'relatedProposals', sourceSingle: true },
	},
	decisions: {
		objectives: { sourceField: 'relatedObjectives' },
		questions: { sourceField: 'relatedQuestions' },
		notes: { sourceField: 'relatedNotes' },
		proposals: { sourceField: 'relatedProposals', targetField: 'decision', targetSingle: true },
	},
};

export function allowedRelatedCollections(collection) {
	return Object.keys(CONTENT_RELATION_POLICIES[collection] ?? {});
}

export function contentRelationPolicy(parentCollection, targetCollection) {
	return CONTENT_RELATION_POLICIES[parentCollection]?.[targetCollection] ?? null;
}

export function canCreateRelatedContent(parentCollection, targetCollection, canManageProject = true) {
	return Boolean(canManageProject && contentRelationPolicy(parentCollection, targetCollection));
}

export function relationFieldForCollection(collection) {
	return RELATION_FIELD_BY_COLLECTION[collection] ?? null;
}
