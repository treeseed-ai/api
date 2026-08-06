import { createHash } from 'node:crypto';

type Row = Record<string, unknown>;

function record(value: unknown): Row {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
}

function text(...values: unknown[]): string | null {
	for (const value of values) if (typeof value === 'string' && value.trim()) return value.trim();
	return null;
}

function assignmentActivityType(assignment: Row): string | null {
	const decision = record(assignment.decisionInput);
	return text(
		decision.activityType,
		record(decision.metadata).activityType,
		record(decision.input).activityType,
		record(assignment.metadata).activityType,
	);
}

function severity(status: unknown, payload: Row) {
	if (status === 'failed' || payload.error) return 'error';
	if (status === 'warning') return 'warning';
	return 'info';
}

export function modeRunActivityEvent(input: { assignment: Row; modeRun: Row }) {
	const { assignment, modeRun } = input;
	const outputs = record(modeRun.outputs);
	const outputMetadata = record(outputs.metadata);
	const message = record(outputMetadata.message);
	const payload = record(message.payload);
	const item = record(payload.item);
	const metadata = record(modeRun.metadata);
	const eventType = text(payload.eventType, message.type, metadata.source, outputs.status, 'agent.mode-run')!;
	const summary = text(
		item.text,
		item.command,
		record(payload.error).message,
		outputs.summary,
		`${eventType} recorded.`,
	)!;
	const payloadDigest = text(payload.payloadDigest)
		?? createHash('sha256').update(JSON.stringify({ eventType, item, outputs: { status: outputs.status, summary: outputs.summary } })).digest('hex');
	return {
		id: `activity:${String(modeRun.id)}`,
		projectId: text(modeRun.projectId, assignment.projectId),
		workdayId: text(assignment.workDayId),
		assignmentId: text(modeRun.providerAssignmentId, assignment.id),
		modeRunId: text(modeRun.id),
		eventType,
		status: modeRun.status === 'failed' ? 'failed' : modeRun.status === 'running' ? 'active' : 'recorded',
		title: text(item.type, outputs.status, eventType),
		message: summary.slice(0, 1_000),
		parameters: {},
		context: {
			agentId: text(modeRun.agentId, assignment.agentId),
			agentClassId: text(modeRun.projectAgentClassId, assignment.projectAgentClassId),
			activityType: assignmentActivityType(assignment),
			handlerId: text(modeRun.handlerId, assignment.handlerId),
			capacityProviderId: text(modeRun.capacityProviderId, assignment.capacityProviderId),
			providerManagerId: text(metadata.providerManagerId),
			runnerId: text(metadata.runnerId, assignment.runnerId),
			executionProviderId: text(modeRun.executionProviderId, assignment.executionProviderId),
			executionRunId: text(record(modeRun.traceRefs).executionRunId),
			contextPackDigest: text(record(record(assignment.decisionInput).contextPack).digest, record(assignment.metadata).contextPackDigest),
		},
		refs: {
			transcriptRef: `mode-run://${String(modeRun.id)}`,
			artifacts: Array.isArray(outputs.artifacts) ? outputs.artifacts : [],
		},
		metadata: {
			sourceEventId: text(metadata.telemetryEventId, modeRun.id),
			severity: severity(modeRun.status, payload),
			usageDelta: record(payload.usage),
			durationMs: null,
			errorCategory: text(record(payload.error).code, record(payload.error).message),
			recoveryState: text(metadata.recoveryState),
			redactionStatus: text(payload.redactionStatus, 'sanitized'),
			payloadDigest,
		},
		createdAt: text(modeRun.createdAt, new Date().toISOString()),
	};
}
