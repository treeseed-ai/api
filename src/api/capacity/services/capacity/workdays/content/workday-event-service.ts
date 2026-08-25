import type { CapacityWorkdayEventRecord } from '@treeseed/sdk/agent-capacity';
import type { CapacityPage,CapacityPageCursor } from '@treeseed/sdk/capacity-pagination';
import { randomUUID } from 'node:crypto';
import type { CapacityGovernanceDatabase } from '../../../../database.ts';
import { CapacityGovernanceError } from '../../../../database.ts';
import {
CapacityWorkdayEventRepository,
parseCapacityWorkdayEventStatus,
} from '../../../../repositories/capacity/workdays/workday-event.ts';
import { CapacityWorkdayRunRepository } from '../../../../repositories/capacity/workdays/workday-run.ts';
import { appendDiscussionEvent } from '../../../../../discussions/content.ts';
import { persistSessionEvent } from '../../../../../realtime/session-events.ts';
import { canonicalJson } from '../../../../security.ts';

type JsonRecord = Record<string, unknown>;

function object(value: unknown): JsonRecord { return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {}; }
function nullable(value: unknown): string | null { return typeof value === 'string' && value.trim() ? value.trim() : null; }
export function isTransientCapacityEvent(eventType: string) { return /(?:^|[._-])(?:token[._-]?delta|delta[._-]?token)(?:$|[._-])/iu.test(eventType); }
export function projectsToDiscussionLifecycle(event: Pick<CapacityWorkdayEventRecord,'id'|'eventType'>) {
	return !event.id.startsWith('activity:') && !isTransientCapacityEvent(event.eventType);
}

export class CapacityWorkdayEventService {
	private readonly events: CapacityWorkdayEventRepository;
	private readonly runs: CapacityWorkdayRunRepository;

	constructor(private readonly database: CapacityGovernanceDatabase) {
		this.events = new CapacityWorkdayEventRepository(database);
		this.runs = new CapacityWorkdayRunRepository(database);
	}

	async create(teamId: string, runId: string, input: JsonRecord): Promise<CapacityWorkdayEventRecord | null> {
		const run = await this.runs.get(teamId, runId);
		if (!run) return null;
		const eventType = nullable(input.eventType ?? input.type);
		if (!eventType) throw new CapacityGovernanceError('capacity_workday_event_type_required', 'Capacity workday events require eventType.', 400);
		if (isTransientCapacityEvent(eventType)) throw new CapacityGovernanceError('capacity_workday_event_transient_only', 'Transient token deltas must use the authenticated streaming channel and cannot become durable events.', 400);
		const id = nullable(input.id) ?? randomUUID();
		const write = {
			id,
			projectId: nullable(input.projectId), workdayId: nullable(input.workdayId ?? input.workDayId),
			assignmentId: nullable(input.assignmentId), modeRunId: nullable(input.modeRunId), eventType,
			status: parseCapacityWorkdayEventStatus(input.status ?? 'recorded'), title: nullable(input.title), message: nullable(input.message),
			parameters: object(input.parameters), context: object(input.context), refs: object(input.refs), metadata: object(input.metadata),
			createdAt: nullable(input.createdAt) ?? new Date().toISOString(),
		};
		const existing = await this.events.get(teamId, runId, id);
		if (existing) {
			const comparable = (value: CapacityWorkdayEventRecord | typeof write) => ({
				projectId: value.projectId, workdayId: value.workdayId, assignmentId: value.assignmentId, modeRunId: value.modeRunId,
				eventType: value.eventType, status: value.status, title: value.title, message: value.message,
				parameters: value.parameters, context: value.context, refs: value.refs, metadata: value.metadata, createdAt: value.createdAt,
			});
			const replayWrite = nullable(input.createdAt) ? write : { ...write, createdAt: existing.createdAt };
			if (canonicalJson(comparable(existing)) !== canonicalJson(comparable(replayWrite))) throw new CapacityGovernanceError(
				'capacity_workday_event_idempotency_conflict', 'Capacity workday event id is bound to different evidence.', 409,
				{ teamId, runId, eventId: id },
			);
			return existing;
		}
		const event = await this.events.create(teamId, runId, write);
		if (!event) throw new CapacityGovernanceError('capacity_workday_event_conflict', 'Capacity workday event could not be persisted because its id is owned by another run or the run changed concurrently.', 409, { teamId, runId, eventId: id });
		await persistSessionEvent(this.database, {
			eventType: 'resource.invalidated', teamId, projectId: event.projectId, resourceId: runId,
			payload: { resource: 'workday', workdayId: runId, eventId: event.id, endpoints: [`/v1/teams/${teamId}/workday-runs/${runId}`] },
		}).catch((error: unknown) => console.warn('[api] Workday session event degraded', { error: error instanceof Error ? error.message : String(error) }));
		const discussion = object(run.parameters.discussion);
		const discussionId = nullable(discussion.discussionId);
		if (discussionId && event.projectId && projectsToDiscussionLifecycle(event)) {
			await appendDiscussionEvent({ store: this.database, projectId: event.projectId, teamId, discussionId, event: event as unknown as JsonRecord });
		}
		return event;
	}

	list(teamId: string, runId: string, filters: { limit?: unknown; cursor?: CapacityPageCursor | null; afterEventIndex?: number | null } = {}): Promise<CapacityPage<CapacityWorkdayEventRecord>> {
		return this.events.list(teamId, runId, filters);
	}
}
