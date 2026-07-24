import { randomUUID } from 'node:crypto';
import type { CapacityWorkdayEventRecord } from '@treeseed/sdk/agent-capacity';
import type { CapacityPage, CapacityPageCursor } from '@treeseed/sdk/capacity-pagination';
import { CapacityGovernanceError } from '../../../../database.ts';
import {
	CapacityWorkdayEventRepository,
	parseCapacityWorkdayEventStatus,
} from '../../../../repositories/capacity/workdays/workday-event.ts';
import { CapacityWorkdayRunRepository } from '../../../../repositories/capacity/workdays/workday-run.ts';
import type { CapacityGovernanceDatabase } from '../../../../database.ts';

type JsonRecord = Record<string, unknown>;

function object(value: unknown): JsonRecord { return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {}; }
function nullable(value: unknown): string | null { return typeof value === 'string' && value.trim() ? value.trim() : null; }

export class CapacityWorkdayEventService {
	private readonly events: CapacityWorkdayEventRepository;
	private readonly runs: CapacityWorkdayRunRepository;

	constructor(private readonly database: CapacityGovernanceDatabase) {
		this.events = new CapacityWorkdayEventRepository(database);
		this.runs = new CapacityWorkdayRunRepository(database);
	}

	async create(teamId: string, runId: string, input: JsonRecord): Promise<CapacityWorkdayEventRecord | null> {
		if (!await this.runs.get(teamId, runId)) return null;
		const eventType = nullable(input.eventType ?? input.type);
		if (!eventType) throw new CapacityGovernanceError('capacity_workday_event_type_required', 'Capacity workday events require eventType.', 400);
		const id = nullable(input.id) ?? randomUUID();
		const event = await this.events.create(teamId, runId, {
			id,
			projectId: nullable(input.projectId), workdayId: nullable(input.workdayId ?? input.workDayId),
			assignmentId: nullable(input.assignmentId), modeRunId: nullable(input.modeRunId), eventType,
			status: parseCapacityWorkdayEventStatus(input.status ?? 'recorded'), title: nullable(input.title), message: nullable(input.message),
			parameters: object(input.parameters), context: object(input.context), refs: object(input.refs), metadata: object(input.metadata),
			createdAt: nullable(input.createdAt) ?? new Date().toISOString(),
		});
		if (!event) throw new CapacityGovernanceError('capacity_workday_event_conflict', 'Capacity workday event could not be persisted because its id is owned by another run or the run changed concurrently.', 409, { teamId, runId, eventId: id });
		return event;
	}

	list(teamId: string, runId: string, filters: { limit?: unknown; cursor?: CapacityPageCursor | null } = {}): Promise<CapacityPage<CapacityWorkdayEventRecord>> {
		return this.events.list(teamId, runId, filters);
	}
}
