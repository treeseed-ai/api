type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

export function composeAssignmentLifecycleOutput(
	input: JsonRecord,
	performance: unknown,
	reviewDisposition?: 'approved' | 'request-changes' | null,
) {
	const artifactManifest = record(input.artifactManifest);
	const activityCompletion = record(record(input.output ?? input.summary).activityCompletion);
	return {
		...record(input.output ?? input.summary),
		...(reviewDisposition ? { activityCompletion: { ...activityCompletion, reviewDisposition } } : {}),
		...(Object.keys(artifactManifest).length ? { artifactManifest } : {}),
		completion: input.completion ?? null,
		performance,
	};
}
