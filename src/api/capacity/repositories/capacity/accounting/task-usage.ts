import {
	encodeCapacityPageCursor,
	normalizeCapacityPageLimit,
	type CapacityPageCursor,
} from '@treeseed/sdk/capacity-pagination';
import type { CapacityUsageActual } from '@treeseed/sdk/agent-capacity';
import type { CapacityGovernanceDatabase } from '../../../database.ts';
import { CapacityGovernanceError } from '../../../database.ts';

type Row = Record<string, unknown>;
type JsonRecord = Record<string, unknown>;

export interface TaskUsagePageFilters {
	workDayId?: string | null;
	cursor?: CapacityPageCursor | null;
	limit?: number;
}

function requiredText(row: Row, column: string): string {
	const value = row[column];
	if (typeof value !== 'string' || !value) {
		throw new CapacityGovernanceError('capacity_task_usage_corrupt', `Task usage actual has invalid ${column}.`, 500, {
			usageActualId: typeof row.id === 'string' ? row.id : null,
			column,
		});
	}
	return value;
}

function nullableText(value: unknown): string | null {
	return typeof value === 'string' && value ? value : null;
}

function capacityMode(value: unknown): CapacityUsageActual['mode'] {
	if (value == null || value === '') return null;
	if (value === 'planning' || value === 'acting') return value;
	throw new CapacityGovernanceError('capacity_task_usage_corrupt', 'Task usage actual has invalid mode.', 500, { mode: String(value) });
}

function accountingMode(value: unknown): CapacityUsageActual['accountingMode'] {
	if (value === 'informational' || value === 'incremental' || value === 'aggregate') return value;
	throw new CapacityGovernanceError('capacity_task_usage_corrupt', 'Task usage actual has invalid accounting_mode.', 500, { accountingMode: String(value) });
}

function nullableNumber(row: Row, column: string): number | null {
	if (row[column] == null) return null;
	const value = Number(row[column]);
	if (!Number.isFinite(value)) {
		throw new CapacityGovernanceError('capacity_task_usage_corrupt', `Task usage actual has invalid ${column}.`, 500, {
			usageActualId: typeof row.id === 'string' ? row.id : null,
			column,
		});
	}
	return value;
}

function nonnegativeNumber(row: Row, column: string): number {
	const value = nullableNumber(row, column);
	if (value == null || value < 0) {
		throw new CapacityGovernanceError('capacity_task_usage_corrupt', `Task usage actual has invalid ${column}.`, 500, {
			usageActualId: typeof row.id === 'string' ? row.id : null,
			column,
		});
	}
	return value;
}

function jsonRecord(row: Row, column: string): JsonRecord {
	const encoded = requiredText(row, column);
	let value: unknown;
	try {
		value = JSON.parse(encoded);
	} catch {
		throw new CapacityGovernanceError('capacity_task_usage_corrupt', `Task usage actual contains invalid ${column}.`, 500, {
			usageActualId: typeof row.id === 'string' ? row.id : null,
			column,
		});
	}
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new CapacityGovernanceError('capacity_task_usage_corrupt', `Task usage actual ${column} must be an object.`, 500, {
			usageActualId: typeof row.id === 'string' ? row.id : null,
			column,
		});
	}
	return value as JsonRecord;
}

export function serializeTaskUsageActualRow(row: Row | null): CapacityUsageActual | null {
	if (!row) return null;
	return {
		id: requiredText(row, 'id'),
		idempotencyKey: requiredText(row, 'idempotency_key'),
		taskId: nullableText(row.task_id),
		workDayId: nullableText(row.work_day_id),
		projectId: requiredText(row, 'project_id'),
		taskSignature: requiredText(row, 'task_signature'),
		executionProfileId: requiredText(row, 'execution_profile_id'),
		assignmentId: nullableText(row.assignment_id),
		assignmentAttempt: nonnegativeNumber(row, 'assignment_attempt'),
		usageDimension: requiredText(row, 'usage_dimension'),
		accountingMode: accountingMode(row.accounting_mode),
		modeRunId: nullableText(row.mode_run_id),
		mode: capacityMode(row.mode),
		capacityProviderId: nullableText(row.capacity_provider_id),
		executionProviderId: nullableText(row.execution_provider_id),
		laneId: nullableText(row.lane_id),
		businessModel: requiredText(row, 'business_model'),
		modelName: nullableText(row.model_name),
		inputTokens: nullableNumber(row, 'input_tokens'),
		outputTokens: nullableNumber(row, 'output_tokens'),
		cachedInputTokens: nullableNumber(row, 'cached_input_tokens'),
		quotaMinutes: nullableNumber(row, 'quota_minutes'),
		wallMinutes: nullableNumber(row, 'wall_minutes'),
		filesOpened: nullableNumber(row, 'files_opened'),
		filesChanged: nullableNumber(row, 'files_changed'),
		diffLinesAdded: nullableNumber(row, 'diff_lines_added'),
		diffLinesRemoved: nullableNumber(row, 'diff_lines_removed'),
		testRuns: nullableNumber(row, 'test_runs'),
		retryCount: nullableNumber(row, 'retry_count'),
		actualCredits: nonnegativeNumber(row, 'actual_credits'),
		actualUsd: nullableNumber(row, 'actual_usd'),
		creditFormulaVersion: requiredText(row, 'credit_formula_version'),
		actualCreditSource: requiredText(row, 'actual_credit_source'),
		nativeUsage: jsonRecord(row, 'native_usage_json'),
		metadata: jsonRecord(row, 'metadata_json'),
		createdAt: requiredText(row, 'created_at'),
	};
}

export async function listTaskUsageActualsPage(
	database: CapacityGovernanceDatabase,
	projectId: string,
	filters: TaskUsagePageFilters = {},
) {
	await database.ensureInitialized();
	const clauses = ['project_id = ?'];
	const values: unknown[] = [projectId];
	if (filters.workDayId) {
		clauses.push('work_day_id = ?');
		values.push(filters.workDayId);
	}
	if (filters.cursor) {
		clauses.push('(created_at < ? OR (created_at = ? AND id < ?))');
		values.push(filters.cursor.createdAt, filters.cursor.createdAt, filters.cursor.id);
	}
	const limit = normalizeCapacityPageLimit(filters.limit);
	const rows = await database.all(
		`SELECT * FROM capacity_usage_actuals
		 WHERE ${clauses.join(' AND ')}
		 ORDER BY created_at DESC, id DESC LIMIT ?`,
		[...values, limit + 1],
	);
	const hasMore = rows.length > limit;
	const selected = rows.slice(0, limit);
	const last = selected.at(-1);
	return {
		items: selected.map((row) => serializeTaskUsageActualRow(row) as CapacityUsageActual),
		page: {
			limit,
			hasMore,
			nextCursor: hasMore && last
				? encodeCapacityPageCursor({ createdAt: requiredText(last, 'created_at'), id: requiredText(last, 'id') })
				: null,
		},
	};
}

export async function listRecentTaskUsageActuals(
	database: CapacityGovernanceDatabase,
	input: { projectId?: string; taskSignature?: string; executionProfileId?: string; limit?: number },
): Promise<CapacityUsageActual[]> {
	await database.ensureInitialized();
	const clauses: string[] = [];
	const values: unknown[] = [];
	if (input.projectId) {
		clauses.push('project_id = ?');
		values.push(input.projectId);
	}
	if (input.taskSignature) {
		clauses.push('task_signature = ?');
		values.push(input.taskSignature);
	}
	if (input.executionProfileId) {
		clauses.push('execution_profile_id = ?');
		values.push(input.executionProfileId);
	}
	if (!clauses.length) {
		throw new CapacityGovernanceError('capacity_task_usage_scope_required', 'A project or task signature is required.', 400);
	}
	const limit = Math.max(1, Math.min(200, Number(input.limit) || 50));
	const rows = await database.all(
		`SELECT * FROM capacity_usage_actuals WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ?`,
		[...values, limit],
	);
	return rows.map((row) => serializeTaskUsageActualRow(row) as CapacityUsageActual);
}
