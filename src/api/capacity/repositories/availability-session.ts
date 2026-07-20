import type { ProviderAvailabilitySession, ProviderAvailabilitySessionStatus } from '@treeseed/sdk/capacity-provider/contracts';
import { encodeCapacityPageCursor, type CapacityPage, type CapacityPageCursor } from '@treeseed/sdk/capacity-pagination';
import { decodeDurableJsonArray, decodeDurableJsonObject } from '../durable-json.ts';
import type { CapacityDatabaseOperation, CapacityGovernanceDatabase } from '../database.ts';
import { CapacityGovernanceError } from '../database.ts';

type Row = Record<string, unknown>;
type JsonRecord = Record<string, unknown>;
const STATUSES = new Set<ProviderAvailabilitySessionStatus>(['open', 'draining', 'closed', 'expired']);

function text(value: unknown) { return value == null ? '' : String(value); }
function nullableText(value: unknown) { return value == null ? null : String(value); }
function context(id: string, column: string) { return { owner: 'provider availability session', ownerId: id, column }; }

function status(value: unknown, id: string): ProviderAvailabilitySessionStatus {
	const candidate = text(value) as ProviderAvailabilitySessionStatus;
	if (!STATUSES.has(candidate)) throw new CapacityGovernanceError('provider_availability_status_invalid', `Availability session ${id} has invalid status ${candidate || '(empty)'}.`, 500, { sessionId: id });
	return candidate;
}

export function serializeAvailabilitySessionRow(row: Row | null): ProviderAvailabilitySession | null {
	if (!row) return null;
	const id = text(row.id);
	for (const [field, value] of [['id', id], ['membershipId', row.membership_id], ['teamId', row.team_id], ['providerId', row.capacity_provider_id], ['openedAt', row.opened_at], ['refreshedAt', row.refreshed_at], ['expiresAt', row.expires_at]] as const) {
		if (!text(value)) throw new CapacityGovernanceError('provider_availability_record_invalid', `Availability session ${id || '(unknown)'} requires ${field}.`, 500, { sessionId: id || null, field });
	}
	const sequence = Number(row.sequence);
	if (!Number.isInteger(sequence) || sequence < 1) throw new CapacityGovernanceError('provider_availability_sequence_invalid', `Availability session ${id} has invalid sequence.`, 500, { sessionId: id });
	const executionProviders = decodeDurableJsonArray<JsonRecord>(row.execution_providers_json, context(id, 'execution_providers_json'));
	const capabilities = decodeDurableJsonArray<string>(row.capabilities_json, context(id, 'capabilities_json'));
	const nativeLimits = decodeDurableJsonObject(row.native_limits_json, context(id, 'native_limits_json'));
	const pressure = decodeDurableJsonObject(row.runner_pressure_json, context(id, 'runner_pressure_json'));
	const constraints = decodeDurableJsonObject(row.constraints_json, context(id, 'constraints_json'));
	const pressureValue = String(pressure.throttleState ?? pressure.pressure ?? 'normal');
	if (!['idle', 'normal', 'busy', 'throttled', 'exhausted'].includes(pressureValue)) throw new CapacityGovernanceError('provider_availability_pressure_invalid', `Availability session ${id} has invalid pressure.`, 500, { sessionId: id });
	return {
		id, membershipId: text(row.membership_id), teamId: text(row.team_id), providerId: text(row.capacity_provider_id), status: status(row.status, id), sequence,
		snapshot: {
			sequence, availableFrom: text(row.available_from || row.opened_at), availableUntil: nullableText(row.available_until),
			pressure: pressureValue as ProviderAvailabilitySession['snapshot']['pressure'],
			maxConcurrentAssignments: Number(pressure.maxConcurrentRunners ?? nativeLimits.maxConcurrentRunners ?? 0),
			activeAssignmentIds: Array.isArray(pressure.activeAssignmentIds) ? pressure.activeAssignmentIds.map(String) : [],
			executionProviders: executionProviders as ProviderAvailabilitySession['snapshot']['executionProviders'], capabilities, constraints,
		},
		openedAt: text(row.opened_at), refreshedAt: text(row.refreshed_at), expiresAt: text(row.expires_at), closedAt: nullableText(row.closed_at),
	};
}

export interface AvailabilitySessionWrite {
	id: string; membershipId: string; teamId: string; providerId: string; environment: string | null; sequence: number;
	openedAt: string; refreshedAt: string; expiresAt: string; availableFrom: string; availableUntil: string | null;
	executionProviders: JsonRecord[]; capabilities: string[]; nativeLimits: JsonRecord; runnerPressure: JsonRecord; constraints: JsonRecord; metadata: JsonRecord;
}

export class AvailabilitySessionRepository {
	constructor(private readonly database: CapacityGovernanceDatabase) {}

	async open(input: AvailabilitySessionWrite, providerOperations: CapacityDatabaseOperation[]) {
		await this.database.ensureInitialized();
		await this.database.batch([
			{ query: `SELECT id FROM capacity_provider_team_memberships WHERE id = ? AND team_id = ? AND capacity_provider_id = ? FOR UPDATE`, params: [input.membershipId, input.teamId, input.providerId] },
			...providerOperations,
			{ query: `UPDATE capacity_provider_availability_sessions SET status = 'closed', closed_at = COALESCE(closed_at, ?), updated_at = ? WHERE membership_id = ? AND status IN ('open','draining')`, params: [input.openedAt, input.openedAt, input.membershipId] },
			{ query: `INSERT INTO capacity_provider_availability_sessions (id, membership_id, team_id, capacity_provider_id, environment, status, sequence, opened_at, refreshed_at, expires_at, available_from, available_until, execution_providers_json, capabilities_json, native_limits_json, runner_pressure_json, constraints_json, metadata_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, params: [input.id, input.membershipId, input.teamId, input.providerId, input.environment, input.sequence, input.openedAt, input.refreshedAt, input.expiresAt, input.availableFrom, input.availableUntil, JSON.stringify(input.executionProviders), JSON.stringify(input.capabilities), JSON.stringify(input.nativeLimits), JSON.stringify(input.runnerPressure), JSON.stringify(input.constraints), JSON.stringify(input.metadata), input.openedAt, input.openedAt] },
		]);
		return this.get(input.teamId, input.id);
	}

	async refresh(input: AvailabilitySessionWrite, expectedSequence: number, providerOperations: CapacityDatabaseOperation[]) {
		await this.database.ensureInitialized();
		const results = await this.database.batch([
			{ query: `SELECT id FROM capacity_provider_availability_sessions WHERE id = ? AND membership_id = ? AND team_id = ? FOR UPDATE`, params: [input.id, input.membershipId, input.teamId] },
			...providerOperations,
			{ query: `UPDATE capacity_provider_availability_sessions SET sequence = sequence + 1, refreshed_at = ?, expires_at = ?, available_from = ?, available_until = ?, execution_providers_json = ?, capabilities_json = ?, native_limits_json = ?, runner_pressure_json = ?, constraints_json = ?, metadata_json = ?, updated_at = ? WHERE id = ? AND membership_id = ? AND team_id = ? AND capacity_provider_id = ? AND status = 'open' AND sequence = ? RETURNING id, sequence`, params: [input.refreshedAt, input.expiresAt, input.availableFrom, input.availableUntil, JSON.stringify(input.executionProviders), JSON.stringify(input.capabilities), JSON.stringify(input.nativeLimits), JSON.stringify(input.runnerPressure), JSON.stringify(input.constraints), JSON.stringify(input.metadata), input.refreshedAt, input.id, input.membershipId, input.teamId, input.providerId, expectedSequence] },
		]);
		const updateResult = (results as Array<{ results?: Row[] }>).at(-1)?.results?.[0] ?? null;
		if (!updateResult || Number(updateResult.sequence) !== expectedSequence + 1) return null;
		return this.get(input.teamId, input.id);
	}

	async close(teamId: string, membershipId: string, sessionId: string) {
		await this.database.ensureInitialized();
		const now = new Date().toISOString();
		await this.database.run(`UPDATE capacity_provider_availability_sessions SET status = 'closed', closed_at = COALESCE(closed_at, ?), updated_at = ? WHERE id = ? AND membership_id = ? AND team_id = ? AND status IN ('open','draining')`, [now, now, sessionId, membershipId, teamId]);
		return this.get(teamId, sessionId);
	}

	async get(teamId: string, sessionId: string) {
		await this.database.ensureInitialized();
		return serializeAvailabilitySessionRow(await this.database.first(`SELECT * FROM capacity_provider_availability_sessions WHERE id = ? AND team_id = ? LIMIT 1`, [sessionId, teamId]));
	}

	async listPage(teamId: string, filters: { providerId?: string | null; status?: ProviderAvailabilitySessionStatus | null; limit: number; cursor: CapacityPageCursor | null }): Promise<CapacityPage<ProviderAvailabilitySession>> {
		await this.database.ensureInitialized();
		const clauses = ['team_id = ?']; const values: unknown[] = [teamId];
		if (filters.providerId) { clauses.push('capacity_provider_id = ?'); values.push(filters.providerId); }
		if (filters.status) { clauses.push('status = ?'); values.push(filters.status); }
		if (filters.cursor) { clauses.push('(created_at < ? OR (created_at = ? AND id < ?))'); values.push(filters.cursor.createdAt, filters.cursor.createdAt, filters.cursor.id); }
		values.push(filters.limit + 1);
		const rows = await this.database.all(`SELECT * FROM capacity_provider_availability_sessions WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ?`, values);
		const hasMore = rows.length > filters.limit; const selected = rows.slice(0, filters.limit); const last = selected.at(-1);
		return { items: selected.map((row) => serializeAvailabilitySessionRow(row) as ProviderAvailabilitySession), page: { limit: filters.limit, hasMore, nextCursor: hasMore && last ? encodeCapacityPageCursor({ createdAt: text(last.created_at), id: text(last.id) }) : null } };
	}
}
