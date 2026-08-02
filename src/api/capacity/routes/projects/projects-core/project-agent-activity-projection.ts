type Row = Record<string, unknown>;

function record(value: unknown): Row {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
}

function selected(source: Row, keys: string[]) {
	return Object.fromEntries(keys.flatMap((key) => source[key] === undefined ? [] : [[key, source[key]]]));
}

function compactContextPack(value: unknown) {
	const pack = record(value);
	const payload = record(pack.pack);
	const diagnostics = record(payload.diagnostics);
	return {
		...selected(pack, ['id', 'source', 'purpose', 'sourceRef', 'revision', 'digest']),
		pack: {
			...selected(payload, ['totalTokenEstimate']),
			diagnostics: selected(diagnostics, ['budget', 'provenancePaths']),
		},
	};
}

function compactWorkPackage(value: unknown) {
	const workPackage = record(value);
	const context = record(workPackage.context);
	const packs = Array.isArray(context.contextPacks) ? context.contextPacks : [];
	return {
		...selected(workPackage, ['id', 'expectedOutputs', 'contextDiagnostics']),
		context: {
			...selected(context, ['coreObjective', 'contextDiagnostics']),
			contextPacks: packs.map(compactContextPack),
		},
	};
}

function compactCodex(value: unknown) {
	return selected(record(value), [
		'provider', 'model', 'threadId', 'turnId', 'status', 'finalResponse', 'usage',
		'tokenCounts', 'durationMs', 'wallMs', 'exitCode', 'error',
	]);
}

function compactMetadata(value: unknown) {
	const metadata = record(value);
	return {
		...selected(metadata, [
			'source', 'provider', 'agent', 'request', 'usage', 'tokenCounts', 'message',
			'toolCall', 'toolResult', 'treeDxCalls', 'contentArtifactRefs', 'contextDiagnostics',
		]),
		...(metadata.workPackage === undefined ? {} : { workPackage: compactWorkPackage(metadata.workPackage) }),
		...(metadata.codex === undefined ? {} : { codex: compactCodex(metadata.codex) }),
	};
}

export function projectAgentActivityProjection(value: unknown) {
	const run = record(value);
	const outputs = record(run.outputs);
	return {
		...selected(run, [
			'id', 'teamId', 'projectId', 'providerAssignmentId', 'capacityProviderId',
			'executionProviderId', 'projectAgentClassId', 'agentId', 'handlerId', 'mode',
			'status', 'traceRefs', 'usageActual', 'validation', 'fallbackReason', 'startedAt',
			'completedAt', 'failedAt', 'createdAt', 'updatedAt', 'metadata',
		]),
		outputs: {
			...selected(outputs, ['status', 'summary', 'usage', 'artifacts', 'externalRef', 'externalUrl', 'code']),
			metadata: compactMetadata(outputs.metadata),
		},
	};
}
