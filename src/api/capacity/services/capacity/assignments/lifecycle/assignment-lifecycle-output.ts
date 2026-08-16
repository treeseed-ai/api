type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

export function composeAssignmentLifecycleOutput(input: JsonRecord, performance: unknown) {
	const artifactManifest = record(input.artifactManifest);
	return {
		...record(input.output ?? input.summary),
		...(Object.keys(artifactManifest).length ? { artifactManifest } : {}),
		completion: input.completion ?? null,
		performance,
	};
}
