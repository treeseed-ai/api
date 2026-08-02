import type { AgentActivityEvent, CapacityWorkdayEventRecord } from '@treeseed/sdk/agent-capacity';

type Row = Record<string, unknown>;

function record(value: unknown): Row {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
}
function text(value: unknown): string | null { return typeof value === 'string' && value ? value : null; }

export function projectWorkdayActivity(event: CapacityWorkdayEventRecord): AgentActivityEvent {
	const context = record(event.context); const refs = record(event.refs); const metadata = record(event.metadata);
	return {
		id: event.id, sequence: event.eventIndex, sourceEventId: text(metadata.sourceEventId) ?? event.id,
		timestamp: event.createdAt, teamId: event.teamId, projectId: event.projectId,
		workdayId: event.workdayId ?? event.runId, assignmentId: event.assignmentId, modeRunId: event.modeRunId,
		executionRunId: text(context.executionRunId), agentId: text(context.agentId), agentClassId: text(context.agentClassId),
		activityType: text(context.activityType), handlerId: text(context.handlerId), capacityProviderId: text(context.capacityProviderId),
		providerManagerId: text(context.providerManagerId), runnerId: text(context.runnerId), executionProviderId: text(context.executionProviderId),
		eventType: event.eventType, severity: ['debug', 'info', 'warning', 'error'].includes(String(metadata.severity))
			? metadata.severity as AgentActivityEvent['severity'] : event.status === 'failed' || event.status === 'error' ? 'error' : 'info',
		summary: event.message ?? event.title ?? event.eventType, transcriptRef: text(refs.transcriptRef),
		artifactRefs: Array.isArray(refs.artifacts) ? refs.artifacts.map(record) : [], contextPackDigest: text(context.contextPackDigest),
		usageDelta: record(metadata.usageDelta), durationMs: Number.isFinite(Number(metadata.durationMs)) ? Number(metadata.durationMs) : null,
		errorCategory: text(metadata.errorCategory), recoveryState: text(metadata.recoveryState),
		redactionStatus: text(metadata.redactionStatus) ?? 'not-required', payloadDigest: text(metadata.payloadDigest) ?? '',
	};
}

export function filterWorkdayActivity(events: CapacityWorkdayEventRecord[], query: Row) {
	const after = Math.max(-1, Number(query.after ?? -1));
	const csv = (value: unknown) => new Set(typeof value === 'string' ? value.split(',').map((entry) => entry.trim()).filter(Boolean) : []);
	const agents = csv(query.agent); const classes = csv(query.agentClass); const types = csv(query.type); const severities = csv(query.severity);
	return events.map(projectWorkdayActivity).filter((event) => event.sequence > after
		&& (!agents.size || Boolean(event.agentId && agents.has(event.agentId)))
		&& (!classes.size || Boolean(event.agentClassId && classes.has(event.agentClassId)))
		&& (!types.size || types.has(event.eventType))
		&& (!severities.size || severities.has(event.severity)));
}

const SENSITIVE_KEY = /(?:authorization|cookie|credential|password|private[_-]?key|secret|(?:access|auth|refresh|api|session)[_-]?token|token$)/iu;
export function redactTranscriptValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(redactTranscriptValue);
	if (!value || typeof value !== 'object') return value;
	return Object.fromEntries(Object.entries(value as Row).map(([key, entry]) => {
		if (SENSITIVE_KEY.test(key)) return [key, '<redacted>'];
		if (key.endsWith('_json') && typeof entry === 'string') {
			try { return [key, redactTranscriptValue(JSON.parse(entry))]; } catch { return [key, '<invalid-json>']; }
		}
		return [key, redactTranscriptValue(entry)];
	}));
}
