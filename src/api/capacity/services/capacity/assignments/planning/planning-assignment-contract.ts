type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord {
	return value && typeof value === 'object' && !Array.isArray(value)
		? value as JsonRecord
		: {};
}

function text(value: unknown): string {
	return typeof value === 'string' ? value.trim() : '';
}

export function compilePlanningAssignmentInput(
	payload: JsonRecord,
	intent: JsonRecord,
	activityType: string,
) {
	const subjectModel = text(intent.subjectModel);
	const subjectId = text(intent.subjectId);
	return {
		...payload,
		...intent,
		activityType,
		subjectModel: subjectModel || null,
		subjectId: subjectId || null,
		...(subjectModel === 'proposal' && subjectId ? { proposalId: subjectId } : {}),
	};
}

export function compilePlanningAllowedOutputs(
	payload: JsonRecord,
	intent: JsonRecord,
	activityType: string,
	allowedWritePaths: string[],
) {
	return {
		paths: allowedWritePaths,
		types: [
			'content_artifact_refs',
			intent.artifactKind,
			activityType === 'estimating' ? 'structured_agent_estimate' : null,
		].filter(Boolean),
		proposalTypes: Array.isArray(intent.proposalTypes)
			? intent.proposalTypes.map(String).filter(Boolean)
			: [],
		publishedSignals: Array.isArray(record(payload.signalPolicy).publishes)
			? record(payload.signalPolicy).publishes
			: [],
	};
}
