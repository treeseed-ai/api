import type { WorkdayCapacityEnvelopeRecord } from '@treeseed/sdk/agent-capacity';
import { randomUUID } from 'node:crypto';
import { decodeDurableJsonObject } from '../durable-json.ts';
import { CapacityGovernanceError, type CapacityGovernanceDatabase } from '../database.ts';
import { CapacityOperationReceiptRepository } from './operation-receipt.ts';
import {
	assertCapacityWorkdayParametersSafe,
	assertCapacityWorkdayTransition,
	capacityWorkdayStatus,
	capacityWorkdayTimestampField,
	type CapacityWorkdayStatus,
} from '../services/workday-lifecycle-service.ts';

type JsonRecord = Record<string, unknown>;
type Row = Record<string, unknown>;

export interface DurableWorkdayCapacityEnvelope extends WorkdayCapacityEnvelopeRecord {
	workdayRunId: string | null;
	metadata: JsonRecord;
	createdAt: string;
	updatedAt: string;
}

export interface CreateWorkdayCapacityEnvelopeInput {
	id?: string;
	workDayId?: string;
	projectId: string;
	workdayRunId?: string | null;
	allocationSetId?: string | null;
	status?: CapacityWorkdayStatus;
	startedAt?: string | null;
	pausedAt?: string | null;
	completedAt?: string | null;
	environment?: string | null;
	availableCredits?: number | null;
	reservedCredits?: number | null;
	consumedCredits?: number | null;
	envelope?: JsonRecord;
	metadata?: JsonRecord;
}

function text(value: unknown): string {
	return value == null ? '' : String(value);
}

function nullableText(value: unknown): string | null {
	return value == null ? null : String(value);
}

function amount(value: unknown, fallback: number | null): number | null {
	if (value == null) return fallback;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : fallback;
}

function object(value: unknown): JsonRecord {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

function json(row: Row, id: string, column: string) {
	return decodeDurableJsonObject(row[column], { owner: 'workday capacity envelope', ownerId: id, column });
}

export function serializeWorkdayCapacityEnvelopeRow(row: Row | null): DurableWorkdayCapacityEnvelope | null {
	if (!row) return null;
	const id = text(row.id);
	return {
		id,
		teamId: text(row.team_id),
		projectId: text(row.project_id),
		workdayRunId: nullableText(row.workday_run_id),
		allocationSetId: nullableText(row.allocation_set_id),
		status: capacityWorkdayStatus(row.status, 'draft'),
		startedAt: nullableText(row.started_at),
		pausedAt: nullableText(row.paused_at),
		completedAt: nullableText(row.completed_at),
		envelope: json(row, id, 'envelope_json') as unknown as DurableWorkdayCapacityEnvelope['envelope'],
		metadata: json(row, id, 'metadata_json'),
		createdAt: text(row.created_at),
		updatedAt: text(row.updated_at),
	};
}

export class WorkdayCapacityEnvelopeRepository {
	private readonly operationReceipts: CapacityOperationReceiptRepository;
	constructor(private readonly database: CapacityGovernanceDatabase) {
		this.operationReceipts = new CapacityOperationReceiptRepository(database);
	}

	async create(input: CreateWorkdayCapacityEnvelopeInput, idempotencyKey?: string | null): Promise<DurableWorkdayCapacityEnvelope | null> {
		await this.database.ensureInitialized();
		const project = await this.database.first(`SELECT id, team_id FROM projects WHERE id = ? LIMIT 1`, [input.projectId]);
		if (!project) return null;
		const operation = idempotencyKey
			? { teamId: text(project.team_id), operation: 'capacity-workday.create', idempotencyKey, request: input }
			: null;
		if (operation) {
			const replay = await this.operationReceipts.replay<DurableWorkdayCapacityEnvelope>(operation);
			if (replay.found) return replay.response;
		}
		const now = new Date().toISOString();
		const id = input.id ?? input.workDayId ?? randomUUID();
		const suppliedEnvelope = object(input.envelope);
		const metadata = object(input.metadata);
		const envelope = {
			teamId: text(project.team_id), projectId: text(project.id), workDayId: id,
			environment: input.environment ?? null,
			allocationSetId: input.allocationSetId ?? nullableText(suppliedEnvelope.allocationSetId),
			availableCredits: amount(input.availableCredits, null), reservedCredits: amount(input.reservedCredits, 0),
			consumedCredits: amount(input.consumedCredits, 0), metadata: object(suppliedEnvelope.metadata ?? metadata),
			...suppliedEnvelope,
		};
		assertCapacityWorkdayParametersSafe(envelope.metadata);
		const workdayStatus = capacityWorkdayStatus(input.status, 'draft');
		const statement = `INSERT INTO workday_capacity_envelopes (
			id, team_id, project_id, workday_run_id, allocation_set_id, status, started_at, paused_at,
			completed_at, envelope_json, metadata_json, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		${operation ? '' : `ON CONFLICT (id) DO UPDATE SET
			team_id = EXCLUDED.team_id, project_id = EXCLUDED.project_id,
			workday_run_id = EXCLUDED.workday_run_id, allocation_set_id = EXCLUDED.allocation_set_id,
			status = EXCLUDED.status, started_at = EXCLUDED.started_at, paused_at = EXCLUDED.paused_at,
			completed_at = EXCLUDED.completed_at, envelope_json = EXCLUDED.envelope_json,
			metadata_json = EXCLUDED.metadata_json, updated_at = EXCLUDED.updated_at`}`;
		const params = [
			id, project.team_id, project.id, input.workdayRunId ?? null, input.allocationSetId ?? envelope.allocationSetId ?? null,
			workdayStatus, input.startedAt ?? null, input.pausedAt ?? null, input.completedAt ?? null,
			JSON.stringify(envelope), JSON.stringify(metadata), now, now,
		];
		if (!operation) {
			await this.database.run(statement, params);
			return this.get(id);
		}
		const response: DurableWorkdayCapacityEnvelope = {
			id, teamId: text(project.team_id), projectId: text(project.id), workdayRunId: input.workdayRunId ?? null,
			allocationSetId: input.allocationSetId ?? nullableText(envelope.allocationSetId), status: workdayStatus,
			startedAt: input.startedAt ?? null, pausedAt: input.pausedAt ?? null, completedAt: input.completedAt ?? null,
			envelope: envelope as DurableWorkdayCapacityEnvelope['envelope'], metadata, createdAt: now, updatedAt: now,
		};
		try {
			await this.database.batch([
				{ query: statement, params },
				this.operationReceipts.insertOperation(operation, 'capacity-workday', id, response, now),
			]);
			return response;
		} catch (error) {
			const raced = await this.operationReceipts.replay<DurableWorkdayCapacityEnvelope>(operation);
			if (raced.found) return raced.response;
			throw error;
		}
	}

	async get(workdayId: string): Promise<DurableWorkdayCapacityEnvelope | null> {
		await this.database.ensureInitialized();
		return serializeWorkdayCapacityEnvelopeRow(await this.database.first(
			`SELECT * FROM workday_capacity_envelopes WHERE id = ? LIMIT 1`, [workdayId],
		));
	}

	async list(projectId: string, filters: { status?: CapacityWorkdayStatus | null } = {}) {
		await this.database.ensureInitialized();
		const values: unknown[] = [projectId];
		const statusClause = filters.status ? ' AND status = ?' : '';
		if (filters.status) values.push(capacityWorkdayStatus(filters.status, 'draft'));
		const rows = await this.database.all(
			`SELECT * FROM workday_capacity_envelopes WHERE project_id = ?${statusClause} ORDER BY created_at DESC, id DESC LIMIT 200`,
			values,
		);
		return rows.map((row) => serializeWorkdayCapacityEnvelopeRow(row) as DurableWorkdayCapacityEnvelope);
	}

	async transition(workdayId: string, status: CapacityWorkdayStatus, idempotencyKey?: string | null) {
		const existing = await this.get(workdayId);
		if (!existing) return null;
		const next = capacityWorkdayStatus(status, existing.status as CapacityWorkdayStatus);
		const operation = idempotencyKey
			? { teamId: existing.teamId, operation: `capacity-workday.transition.${next}`, idempotencyKey, request: { workdayId, status: next } }
			: null;
		if (operation) {
			const replay = await this.operationReceipts.replay<DurableWorkdayCapacityEnvelope>(operation);
			if (replay.found) return replay.response;
		}
		assertCapacityWorkdayTransition(capacityWorkdayStatus(existing.status, 'draft'), next);
		const now = new Date().toISOString();
		const timestampColumn = capacityWorkdayTimestampField(next);
		const statement = `UPDATE workday_capacity_envelopes
			SET status = ?, ${timestampColumn ? `${timestampColumn} = COALESCE(${timestampColumn}, ?),` : ''} updated_at = ?
			WHERE id = ?${operation ? ' AND status = ?' : ''}`;
		const params = timestampColumn
			? [next, now, now, workdayId, ...(operation ? [existing.status] : [])]
			: [next, now, workdayId, ...(operation ? [existing.status] : [])];
		if (!operation) {
			await this.database.run(statement, params);
			return this.get(workdayId);
		}
		const timestampField = next === 'active'
			? 'startedAt'
			: next === 'paused'
				? 'pausedAt'
				: next === 'completed' || next === 'cancelled'
					? 'completedAt'
					: null;
		const response: DurableWorkdayCapacityEnvelope = {
			...existing, status: next,
			...(timestampField ? { [timestampField]: existing[timestampField] ?? now } : {}),
			updatedAt: now,
		};
		const receipt = this.operationReceipts.insertOperationWhen(
			operation, 'capacity-workday', workdayId, response, now,
			'SELECT 1 FROM workday_capacity_envelopes WHERE id = ? AND team_id = ? AND status = ? AND updated_at = ?',
			[workdayId, existing.teamId, next, now],
		);
		try {
			await this.database.batch([{ query: statement, params }, receipt]);
		} catch (error) {
			const raced = await this.operationReceipts.replay<DurableWorkdayCapacityEnvelope>(operation);
			if (raced.found) return raced.response;
			throw error;
		}
		const committed = await this.operationReceipts.replay<DurableWorkdayCapacityEnvelope>(operation);
		if (committed.found) return committed.response;
		throw new CapacityGovernanceError('capacity_workday_transition_conflict', 'Capacity workday transition lost a concurrent state change.', 409, { workdayId, expectedStatus: existing.status });
	}
}
