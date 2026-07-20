import { randomUUID } from 'node:crypto';
import type { CapacityWorkdayRunRecord, CapacityWorkdayRunStatus } from '@treeseed/sdk/agent-capacity';
import type { CapacityGovernanceDatabase } from '../database.ts';
import { CapacityGovernanceError } from '../database.ts';
import { CapacityWorkdayRunRepository, parseCapacityWorkdayRunStatus } from '../repositories/workday-run.ts';
import { CapacityWorkdayRunWriteRepository } from '../repositories/workday-run-write.ts';
import { assertCapacityWorkdayParametersSafe, assertRunningCapacityWorkdayBounded } from './workday-lifecycle-service.ts';
import { recordCapacityWorkdayScheduleFailure } from './workday-scheduling-service.ts';
import { engineeringWorkflowPromotionConfigs } from './engineering-workflow-promotion-service.ts';

type JsonRecord = Record<string, unknown>;
interface WorkdayRunServiceStore extends CapacityGovernanceDatabase {
	scheduleCapacityWorkdayRun(run: CapacityWorkdayRunRecord): Promise<unknown>;
	terminalizeCapacityWorkdayAssignments(teamId: string, runId: string, input: JsonRecord): Promise<unknown>;
	terminalizeCapacityWorkdayEnvelopes(teamId: string, runId: string, status: string): Promise<unknown>;
	closeCapacityWorkdayAdmission(teamId: string, runId: string): Promise<unknown>;
	createCapacityWorkdayEvent(teamId: string, runId: string, input: JsonRecord): Promise<unknown>;
	updateCapacityWorkdayRun(teamId: string, runId: string, input: JsonRecord): Promise<CapacityWorkdayRunRecord | null>;
}

const TERMINAL = new Set<CapacityWorkdayRunStatus>(['completed', 'cancelled', 'failed', 'degraded']);
const TRANSITIONS: Record<CapacityWorkdayRunStatus, readonly CapacityWorkdayRunStatus[]> = {
	queued: ['running', 'cancelled', 'failed'], running: ['completed', 'cancelled', 'failed', 'degraded'],
	completed: [], cancelled: [], failed: [], degraded: [],
};
function object(value: unknown): JsonRecord { return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {}; }
function text(value: unknown, fallback = '') { return typeof value === 'string' && value.trim() ? value.trim() : fallback; }
function nullable(value: unknown): string | null { return typeof value === 'string' && value.trim() ? value.trim() : null; }
function settlementGraceUntil(parameters: JsonRecord, from: string) {
	const seconds = Math.max(300, Number(parameters.settlementGraceSeconds ?? parameters.waitSeconds ?? 0) || 0);
	return new Date(Date.parse(from) + seconds * 1000).toISOString();
}

export class CapacityWorkdayRunService {
	private readonly runs: CapacityWorkdayRunRepository;
	private readonly writes: CapacityWorkdayRunWriteRepository;
	constructor(private readonly store: WorkdayRunServiceStore) { this.runs = new CapacityWorkdayRunRepository(store); this.writes = new CapacityWorkdayRunWriteRepository(store); }

	async create(teamId: string, input: JsonRecord): Promise<CapacityWorkdayRunRecord> {
		const now = new Date().toISOString(); const id = text(input.id, randomUUID());
		const status = parseCapacityWorkdayRunStatus(input.status ?? (input.startedAt ? 'running' : 'queued'));
		const parameters = object(input.parameters); assertCapacityWorkdayParametersSafe(parameters); engineeringWorkflowPromotionConfigs(parameters);
		const durationSeconds = Math.max(0, Number(parameters.durationSeconds ?? input.durationSeconds ?? 0));
		const startedAt = nullable(input.startedAt) ?? (status === 'running' ? now : null);
		const configuredDeadline = text(parameters.deadlineAt);
		const deadlineAt = configuredDeadline && Number.isFinite(Date.parse(configuredDeadline)) ? configuredDeadline
			: startedAt && durationSeconds > 0 ? new Date(Date.parse(startedAt) + durationSeconds * 1000).toISOString() : null;
		assertRunningCapacityWorkdayBounded({ status, durationSeconds, deadlineAt });
		const providerId = nullable(input.capacityProviderId ?? input.providerId);
		const candidate: CapacityWorkdayRunRecord = {
			id, teamId, capacityProviderId: providerId, scenarioId: text(input.scenarioId ?? input.scenario, 'portfolio-local'), status,
			environment: text(input.environment, 'local'), requestedById: nullable(input.requestedById),
			parameters: { ...parameters, seed: parameters.seed ?? input.seed ?? 'treeseed', durationSeconds, deadlineAt },
			summary: object(input.summary), metrics: object(input.metrics), expected: object(input.expected), actual: object(input.actual),
			reportRefs: object(input.reportRefs ?? input.report_refs), error: object(input.error), startedAt, completedAt: nullable(input.completedAt),
			createdAt: now, updatedAt: now,
		};
		const replacement = status === 'running' && candidate.environment === 'local'
			? await this.writes.replaceLocal(candidate)
			: { run: await this.writes.create(candidate), supersededRunIds: [] };
		for (const runId of replacement.supersededRunIds) {
			await this.store.closeCapacityWorkdayAdmission(teamId, runId);
			const staleRun = await this.runs.get(teamId, runId);
			await this.store.terminalizeCapacityWorkdayAssignments(teamId, runId, { now, preserveActiveLeasesUntil: settlementGraceUntil(staleRun?.parameters ?? {}, now), settlementKeyPrefix: 'workday-supersede', source: 'workday_supersede_assignment_close', code: 'superseded_by_new_local_workday', reason: 'Closed stale workday assignment because a newer local workday superseded the run.', metadata: { supersededByRunId: id } });
			await this.store.terminalizeCapacityWorkdayEnvelopes(teamId, runId, 'failed');
		}
		const run = replacement.run;
		if (status === 'running') {
			try { await this.store.scheduleCapacityWorkdayRun(run); }
			catch (error) { await recordCapacityWorkdayScheduleFailure(this.store, run, error, new Date().toISOString()); throw error; }
		}
		return (await this.runs.get(teamId, id))!;
	}

	async update(teamId: string, runId: string, input: JsonRecord): Promise<CapacityWorkdayRunRecord | null> {
		const existing = await this.runs.get(teamId, runId); if (!existing) return null;
		const now = new Date().toISOString(); const status = parseCapacityWorkdayRunStatus(input.status ?? existing.status);
		if (status !== existing.status && !TRANSITIONS[existing.status].includes(status)) throw new CapacityGovernanceError('capacity_workday_run_transition_invalid', `Cannot transition workday run from ${existing.status} to ${status}.`, 409, { runId, from: existing.status, to: status });
		const parameters = object(input.parameters ?? existing.parameters); assertCapacityWorkdayParametersSafe(parameters); engineeringWorkflowPromotionConfigs(parameters);
		const startedAt = nullable(input.startedAt) ?? existing.startedAt ?? (status === 'running' ? now : null);
		assertRunningCapacityWorkdayBounded({ status, durationSeconds: Math.max(0, Number(parameters.durationSeconds ?? 0)), deadlineAt: nullable(parameters.deadlineAt) });
		const next: CapacityWorkdayRunRecord = {
			...existing, capacityProviderId: nullable(input.capacityProviderId ?? input.providerId) ?? existing.capacityProviderId,
			scenarioId: text(input.scenarioId ?? input.scenario, existing.scenarioId), status, environment: text(input.environment, existing.environment),
			parameters, summary: object(input.summary ?? existing.summary), metrics: object(input.metrics ?? existing.metrics),
			expected: object(input.expected ?? existing.expected), actual: object(input.actual ?? existing.actual),
			reportRefs: object(input.reportRefs ?? input.report_refs ?? existing.reportRefs), error: object(input.error ?? existing.error), startedAt,
			completedAt: nullable(input.completedAt) ?? existing.completedAt ?? (TERMINAL.has(status) ? now : null), updatedAt: now,
		};
		if (TERMINAL.has(status) && !TERMINAL.has(existing.status)) await this.store.closeCapacityWorkdayAdmission(teamId, runId);
		const updated = await this.writes.update(next, existing.status);
		if (!updated) throw new CapacityGovernanceError('capacity_workday_run_transition_conflict', 'Workday run changed concurrently.', 409, { runId, expectedStatus: existing.status });
		if (TERMINAL.has(status) && !TERMINAL.has(existing.status)) {
			await this.store.terminalizeCapacityWorkdayAssignments(teamId, runId, { now, preserveActiveLeasesUntil: settlementGraceUntil(parameters, now), settlementKeyPrefix: 'workday-explicit-terminal', source: 'capacity_workday_explicit_terminalization', code: `workday_${status}`, reason: `Workday was explicitly terminalized with status ${status}.`, metadata: { status } });
			await this.store.terminalizeCapacityWorkdayEnvelopes(teamId, runId, status);
		}
		return this.runs.get(teamId, runId);
	}

}
