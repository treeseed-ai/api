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
		intent,
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
	const configured = record(payload.allowedOutputs);
	const configuredKinds = Array.isArray(configured.artifactKinds)
		? configured.artifactKinds.map(String).filter(Boolean)
		: [];
	const artifactKinds = [...new Set([
		...configuredKinds,
		text(intent.artifactKind),
	].filter(Boolean))];
	return {
		paths: allowedWritePaths,
		types: [
			'content_artifact_refs',
			intent.artifactKind,
			activityType === 'estimating' ? 'execution_plan' : null,
		].filter(Boolean),
		artifactKinds,
		proposalTypes: Array.isArray(intent.proposalTypes)
			? intent.proposalTypes.map(String).filter(Boolean)
			: [],
		publishedSignals: Array.isArray(record(payload.signalPolicy).publishes)
			? record(payload.signalPolicy).publishes
			: [],
	};
}
