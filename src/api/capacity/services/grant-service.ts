import { randomUUID } from 'node:crypto';
import { validateCapacityGrantV2, type CapacityGrantV2, type CapacityGrantStatus } from '@treeseed/sdk/agent-capacity/allocation';
import { decodeCapacityPageCursor, encodeCapacityPageCursor, normalizeCapacityPageLimit, type CapacityPage } from '@treeseed/sdk/capacity-pagination';
import type { CapacityGovernanceDatabase } from '../database.ts';
import { CapacityGovernanceError } from '../database.ts';
import { serializeCapacityGrantRow } from '../repositories/grant.ts';
import { CapacityOperationReceiptRepository } from '../repositories/operation-receipt.ts';
import { decodeDurableJsonArray } from '../durable-json.ts';

export class CapacityGrantService {
	private readonly operationReceipts: CapacityOperationReceiptRepository;

	constructor(private readonly database: CapacityGovernanceDatabase) {
		this.operationReceipts = new CapacityOperationReceiptRepository(database);
	}

	private async candidate(teamId: string, input: Record<string, unknown>): Promise<CapacityGrantV2> {
		await this.database.ensureInitialized();
		const membershipId = String(input.membershipId ?? '');
		const membership = await this.database.first(
			'SELECT * FROM capacity_provider_team_memberships WHERE id = ? AND team_id = ? LIMIT 1',
			[membershipId, teamId],
		);
		return {
			schemaVersion: 2,
			id: typeof input.id === 'string' && input.id.trim() ? input.id.trim() : randomUUID(),
			membershipId,
			teamId,
			providerId: String(membership?.capacity_provider_id ?? ''),
			projectId: String(input.projectId ?? ''),
			environment: String(input.environment ?? ''),
			status: 'planned',
			executionProviderIds: Array.isArray(input.executionProviderIds) ? input.executionProviderIds.map(String) : [],
			laneIds: Array.isArray(input.laneIds) ? input.laneIds.map(String) : [],
			capabilities: Array.isArray(input.capabilities) ? input.capabilities.map(String) : [],
			allowedModes: Array.isArray(input.allowedModes) ? input.allowedModes.map(String).filter((mode): mode is 'planning' | 'acting' => mode === 'planning' || mode === 'acting') : [],
			dailyCreditLimit: input.dailyCreditLimit == null ? null : Number(input.dailyCreditLimit),
			monthlyCreditLimit: input.monthlyCreditLimit == null ? null : Number(input.monthlyCreditLimit),
			maxConcurrentAssignments: input.maxConcurrentAssignments == null ? null : Number(input.maxConcurrentAssignments),
			unmetered: input.unmetered === true,
			expiresAt: typeof input.expiresAt === 'string' ? input.expiresAt : null,
			metadata: input.metadata && typeof input.metadata === 'object' && !Array.isArray(input.metadata) ? input.metadata as Record<string, unknown> : {},
		};
	}

	async plan(teamId: string, input: Record<string, unknown>) {
		const candidate = await this.candidate(teamId, input);
		const validation = validateCapacityGrantV2(candidate);
		if (validation.ok) {
			try {
				await this.assertReferences(candidate);
			} catch (error) {
				if (!(error instanceof CapacityGovernanceError)) throw error;
				validation.diagnostics.push({
					code: error.code,
					path: 'references',
					message: error.message,
				});
				validation.ok = false;
			}
		}
		return { candidate, validation };
	}

	private async assertReferences(grant: CapacityGrantV2) {
		const membership = await this.database.first(`SELECT id, status, capacity_provider_id FROM capacity_provider_team_memberships WHERE id = ? AND team_id = ? LIMIT 1`, [grant.membershipId, grant.teamId]);
		if (!membership || membership.status !== 'approved' || String(membership.capacity_provider_id) !== grant.providerId) {
			throw new CapacityGovernanceError('capacity_grant_membership_not_approved', 'Grant membership is not approved for this provider and team.', 409);
		}
		const project = await this.database.first(`SELECT id FROM projects WHERE id = ? AND team_id = ? LIMIT 1`, [grant.projectId, grant.teamId]);
		if (!project) throw new CapacityGovernanceError('capacity_grant_project_not_found', 'Grant project does not exist in this team.', 404);
		if (grant.expiresAt && Date.parse(grant.expiresAt) <= Date.now()) throw new CapacityGovernanceError('capacity_grant_expired', 'An expired capacity grant cannot be activated.', 409);
		const providers = await this.database.all(`SELECT id, status, capabilities_json FROM capacity_execution_providers WHERE capacity_provider_id = ? AND id IN (${grant.executionProviderIds.map(() => '?').join(', ')})`, [grant.providerId, ...grant.executionProviderIds]);
		const providerById = new Map(providers.map((provider) => [String(provider.id), provider]));
		const missingProviders = grant.executionProviderIds.filter((id) => providerById.get(id)?.status !== 'active');
		if (missingProviders.length) throw new CapacityGovernanceError('capacity_grant_execution_provider_invalid', 'Grant execution providers must exist and be active for the membership provider.', 409, { executionProviderIds: missingProviders });
		const lanes = grant.laneIds.length
			? await this.database.all(`SELECT id, execution_provider_id, status, capabilities_json FROM capacity_provider_lanes WHERE capacity_provider_id = ? AND id IN (${grant.laneIds.map(() => '?').join(', ')})`, [grant.providerId, ...grant.laneIds])
			: [];
		const laneById = new Map(lanes.map((lane) => [String(lane.id), lane]));
		const invalidLanes = grant.laneIds.filter((id) => {
			const lane = laneById.get(id);
			return !lane || lane.status !== 'active' || !grant.executionProviderIds.includes(String(lane.execution_provider_id));
		});
		if (invalidLanes.length) throw new CapacityGovernanceError('capacity_grant_lane_invalid', 'Grant lanes must exist, be active, and belong to a selected execution provider.', 409, { laneIds: invalidLanes });
		const capabilities = new Set<string>();
		for (const provider of providers) for (const capability of decodeDurableJsonArray<string>(provider.capabilities_json, { owner: 'capacity execution provider', ownerId: String(provider.id), column: 'capabilities_json' })) capabilities.add(capability);
		for (const lane of lanes) for (const capability of decodeDurableJsonArray<string>(lane.capabilities_json, { owner: 'capacity provider lane', ownerId: String(lane.id), column: 'capabilities_json' })) capabilities.add(capability);
		const unavailableCapabilities = grant.capabilities.filter((capability) => !capabilities.has(capability));
		if (unavailableCapabilities.length) throw new CapacityGovernanceError('capacity_grant_capability_invalid', 'Grant capabilities must be advertised by a selected execution provider or lane.', 409, { capabilities: unavailableCapabilities });
	}

	private query(filters: { projectId?: string; membershipId?: string; providerId?: string; environment?: string; status?: CapacityGrantStatus }) {
		const clauses = ['team_id = ?'];
		const values: unknown[] = [];
		if (filters.projectId) { clauses.push('project_id = ?'); values.push(filters.projectId); }
		if (filters.membershipId) { clauses.push('membership_id = ?'); values.push(filters.membershipId); }
		if (filters.providerId) { clauses.push('capacity_provider_id = ?'); values.push(filters.providerId); }
		if (filters.environment) { clauses.push('environment = ?'); values.push(filters.environment); }
		if (filters.status) { clauses.push('status = ?'); values.push(filters.status); }
		return { clauses, values };
	}

	async listPage(teamId: string, filters: { projectId?: string; membershipId?: string; providerId?: string; environment?: string; status?: CapacityGrantStatus; limit?: unknown; cursor?: unknown } = {}): Promise<CapacityPage<CapacityGrantV2>> {
		await this.database.ensureInitialized();
		let limit: number;
		let cursor;
		try {
			limit = normalizeCapacityPageLimit(filters.limit);
			cursor = decodeCapacityPageCursor(filters.cursor);
		} catch (error) {
			throw new CapacityGovernanceError('capacity_page_invalid', error instanceof Error ? error.message : String(error), 400);
		}
		const { clauses, values } = this.query(filters);
		values.unshift(teamId);
		if (cursor) {
			clauses.push('(created_at < ? OR (created_at = ? AND id > ?))');
			values.push(cursor.createdAt, cursor.createdAt, cursor.id);
		}
		values.push(limit + 1);
		const rows = await this.database.all(`SELECT * FROM capacity_grants WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC, id ASC LIMIT ?`, values);
		const hasMore = rows.length > limit;
		const pageRows = rows.slice(0, limit);
		const last = pageRows.at(-1);
		return {
			items: pageRows.map(serializeCapacityGrantRow),
			page: {
				limit,
				hasMore,
				nextCursor: hasMore && last ? encodeCapacityPageCursor({ createdAt: String(last.created_at), id: String(last.id) }) : null,
			},
		};
	}

	async activePlanningMatches(input: {
		teamId: string;
		membershipId: string;
		providerId: string;
		projectId: string;
		environment: string;
		at: string;
	}) {
		await this.database.ensureInitialized();
		const rows = await this.database.all(
			`SELECT * FROM capacity_grants
			 WHERE team_id = ?
			   AND membership_id = ?
			   AND capacity_provider_id = ?
			   AND project_id = ?
			   AND environment = ?
			   AND status = 'active'
			   AND allowed_modes_json LIKE '%"planning"%'
			   AND (expires_at IS NULL OR expires_at > ?)
			 ORDER BY created_at DESC, id ASC
			 LIMIT 2`,
			[input.teamId, input.membershipId, input.providerId, input.projectId, input.environment, input.at],
		);
		return rows.map(serializeCapacityGrantRow);
	}

	async get(teamId: string, grantId: string) {
		await this.database.ensureInitialized();
		const row = await this.database.first(`SELECT * FROM capacity_grants WHERE id = ? AND team_id = ? LIMIT 1`, [grantId, teamId]);
		return row ? serializeCapacityGrantRow(row) : null;
	}

	async create(teamId: string, input: Record<string, unknown>, idempotencyKey: string) {
		await this.database.ensureInitialized();
		const operation = { teamId, operation: 'capacity-grant.create', idempotencyKey, request: input };
		const replay = await this.operationReceipts.replay<CapacityGrantV2>(operation);
		if (replay.found) return replay.response;
		const membershipId = String(input.membershipId ?? '');
		const projectId = String(input.projectId ?? '');
		const membership = await this.database.first(`SELECT * FROM capacity_provider_team_memberships WHERE id = ? AND team_id = ? LIMIT 1`, [membershipId, teamId]);
		if (!membership || membership.status !== 'approved') throw new CapacityGovernanceError('capacity_grant_membership_not_approved', 'Grant membership is not approved for this team.', 409);
		const project = await this.database.first(`SELECT id FROM projects WHERE id = ? AND team_id = ? LIMIT 1`, [projectId, teamId]);
		if (!project) throw new CapacityGovernanceError('capacity_grant_project_not_found', 'Grant project does not exist in this team.', 404);
		const grant = await this.candidate(teamId, input);
		const validation = validateCapacityGrantV2(grant);
		if (!validation.ok) throw new CapacityGovernanceError('capacity_grant_invalid', 'Capacity grant is invalid.', 400, { diagnostics: validation.diagnostics });
		await this.assertReferences(grant);
		const now = new Date().toISOString();
		try {
			await this.database.batch([
				{
					query: `INSERT INTO capacity_grants (id, membership_id, capacity_provider_id, team_id, project_id, environment, status, execution_provider_ids_json, lane_ids_json, capabilities_json, allowed_modes_json, daily_credit_limit, monthly_credit_limit, max_concurrent_assignments, unmetered, expires_at, metadata_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					params: [grant.id, grant.membershipId, grant.providerId, grant.teamId, grant.projectId, grant.environment, grant.status, JSON.stringify(grant.executionProviderIds), JSON.stringify(grant.laneIds), JSON.stringify(grant.capabilities), JSON.stringify(grant.allowedModes), grant.dailyCreditLimit ?? null, grant.monthlyCreditLimit ?? null, grant.maxConcurrentAssignments ?? null, grant.unmetered ? 1 : 0, grant.expiresAt ?? null, JSON.stringify(grant.metadata ?? {}), now, now],
				},
				this.operationReceipts.insertOperation(operation, 'capacity-grant', grant.id, grant, now),
			]);
			return grant;
		} catch (error) {
			const raced = await this.operationReceipts.replay<CapacityGrantV2>(operation);
			if (raced.found) return raced.response;
			throw error;
		}
	}

	async transition(teamId: string, grantId: string, status: CapacityGrantStatus, idempotencyKey: string) {
		const operation = {
			teamId,
			operation: `capacity-grant.transition.${status}`,
			idempotencyKey,
			request: { grantId, status },
		};
		const replay = await this.operationReceipts.replay<CapacityGrantV2>(operation);
		if (replay.found) return replay.response;
		const existing = await this.get(teamId, grantId);
		if (!existing) throw new CapacityGovernanceError('capacity_grant_not_found', 'Capacity grant does not exist.', 404);
		const allowed: Record<CapacityGrantStatus, CapacityGrantStatus[]> = { planned: ['active', 'revoked'], active: ['paused', 'revoked', 'expired'], paused: ['active', 'revoked', 'expired'], revoked: [], expired: [] };
		if (!allowed[existing.status].includes(status)) throw new CapacityGovernanceError('capacity_grant_transition_invalid', `Cannot transition grant from ${existing.status} to ${status}.`, 409);
		if (status === 'active') await this.assertReferences(existing);
		const now = new Date().toISOString();
		const response = { ...existing, status };
		const receipt = this.operationReceipts.insertOperationWhen(
			operation,
			'capacity-grant',
			grantId,
			response,
			now,
			'SELECT 1 FROM capacity_grants WHERE id = ? AND team_id = ? AND status = ?',
			[grantId, teamId, status],
		);
		try {
			await this.database.batch([
				{ query: 'SELECT id FROM teams WHERE id = ? FOR UPDATE', params: [teamId] },
				{ query: 'UPDATE capacity_grants SET status = ?, updated_at = ? WHERE id = ? AND team_id = ? AND status = ?', params: [status, now, grantId, teamId, existing.status] },
				receipt,
			]);
		} catch (error) {
			const raced = await this.operationReceipts.replay<CapacityGrantV2>(operation);
			if (raced.found) return raced.response;
			throw error;
		}
		const committed = await this.operationReceipts.replay<CapacityGrantV2>(operation);
		if (committed.found) return committed.response;
		throw new CapacityGovernanceError('capacity_grant_transition_conflict', 'Capacity grant transition lost a concurrent state change.', 409, { grantId, expectedStatus: existing.status });
	}
}
