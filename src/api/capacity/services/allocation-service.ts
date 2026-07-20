import { randomUUID } from 'node:crypto';
import {
	validateCapacityAllocationSetV2,
	type CapacityAllocationSetV2,
} from '@treeseed/sdk/agent-capacity/allocation';
import type { CapacityPageCursor } from '@treeseed/sdk/capacity-pagination';
import type { CapacityGovernanceDatabase } from '../database.ts';
import { CapacityGovernanceError } from '../database.ts';
import { CapacityAllocationSetRepository } from '../repositories/allocation-set.ts';
import { CapacityOperationReceiptRepository } from '../repositories/operation-receipt.ts';
import { decodeDurableJsonArray } from '../durable-json.ts';

export class CapacityAllocationPolicyError extends Error {
	constructor(
		readonly diagnostics: ReturnType<typeof validateCapacityAllocationSetV2>['diagnostics'],
		readonly code = 'capacity_allocation_policy_invalid',
		readonly status = 400,
		message = 'Capacity allocation policy is invalid.',
	) {
		super(message);
		this.name = 'CapacityAllocationPolicyError';
	}
}

export interface CapacityAllocationPlan {
	candidate: CapacityAllocationSetV2;
	validation: ReturnType<typeof validateCapacityAllocationSetV2>;
}

export class CapacityAllocationService {
	private readonly repository: CapacityAllocationSetRepository;
	private readonly operationReceipts: CapacityOperationReceiptRepository;

	constructor(private readonly database: CapacityGovernanceDatabase) {
		this.repository = new CapacityAllocationSetRepository(database);
		this.operationReceipts = new CapacityOperationReceiptRepository(database);
	}

	private async validateReferences(candidate: CapacityAllocationSetV2) {
		const diagnostics: ReturnType<typeof validateCapacityAllocationSetV2>['diagnostics'] = [];
		const add = (code: string, path: string, message: string) => diagnostics.push({ code, path, message });
		for (const [index, slice] of candidate.slices.entries()) {
			if (slice.scope === 'project') {
				const project = await this.database.first(`SELECT id FROM projects WHERE id = ? AND team_id = ? LIMIT 1`, [slice.targetId, candidate.teamId]);
				if (!project) add('allocation_project_not_found', `slices[${index}].targetId`, `Project ${slice.targetId} does not exist in this team.`);
				continue;
			}
			if (slice.scope === 'agent-class') {
				const parent = candidate.slices.find((entry) => entry.id === slice.parentSliceId);
				const agentClass = await this.database.first(`SELECT id, project_id, status FROM project_agent_classes WHERE id = ? AND team_id = ? LIMIT 1`, [slice.targetId, candidate.teamId]);
				if (!agentClass || agentClass.status !== 'active') add('allocation_agent_class_not_eligible', `slices[${index}].targetId`, `Agent class ${slice.targetId} does not exist or is not active.`);
				else if (!parent || String(agentClass.project_id) !== parent.targetId) add('allocation_agent_class_project_mismatch', `slices[${index}].parentSliceId`, `Agent class ${slice.targetId} does not belong to its parent project slice.`);
				continue;
			}
			const parent = candidate.slices.find((entry) => entry.id === slice.parentSliceId);
			const agentClass = parent ? await this.database.first(`SELECT id, allowed_modes_json FROM project_agent_classes WHERE id = ? AND team_id = ? LIMIT 1`, [parent.targetId, candidate.teamId]) : null;
			if (slice.targetId !== 'planning' && slice.targetId !== 'acting') add('allocation_mode_invalid', `slices[${index}].targetId`, 'Mode allocation targets must be planning or acting.');
			else if (!agentClass || !decodeDurableJsonArray<string>(agentClass.allowed_modes_json, { owner: 'project agent class', ownerId: parent?.targetId ?? null, column: 'allowed_modes_json' }).includes(slice.targetId)) add('allocation_mode_not_supported', `slices[${index}].targetId`, `Agent class ${parent?.targetId ?? '(missing)'} does not support ${slice.targetId}.`);
		}
		return diagnostics;
	}

	get(teamId: string, allocationSetId: string) { return this.repository.get(teamId, allocationSetId); }
	getActive(teamId: string) { return this.repository.getActive(teamId); }
	listPage(teamId: string, page: { limit: number; cursor: CapacityPageCursor | null }) { return this.repository.listPage(teamId, page); }
	nextVersion(teamId: string) { return this.repository.nextVersion(teamId); }

	async plan(teamId: string, input: Record<string, unknown>, createdById: string | null = null): Promise<CapacityAllocationPlan> {
		const nextVersion = await this.repository.nextVersion(teamId);
		const policy = input.policy && typeof input.policy === 'object' && !Array.isArray(input.policy) ? input.policy as Record<string, unknown> : {};
		const candidate: CapacityAllocationSetV2 = {
			schemaVersion: 2,
			id: typeof input.id === 'string' && input.id.trim() ? input.id.trim() : randomUUID(),
			teamId,
			version: Number.isInteger(Number(input.version)) ? Number(input.version) : nextVersion,
			status: input.status === 'validated' ? 'validated' : 'draft',
			effectiveFrom: typeof input.effectiveFrom === 'string' ? input.effectiveFrom : new Date().toISOString(),
			effectiveUntil: typeof input.effectiveUntil === 'string' ? input.effectiveUntil : null,
			reservePolicy: (input.reservePolicy ?? policy.reservePolicy ?? { percent: 0, overflow: 'deny' }) as CapacityAllocationSetV2['reservePolicy'],
			slices: Array.isArray(input.slices) ? input.slices as CapacityAllocationSetV2['slices'] : [],
			borrowingRules: Array.isArray(input.borrowingRules) ? input.borrowingRules as CapacityAllocationSetV2['borrowingRules'] : [],
			createdById,
			metadata: input.metadata && typeof input.metadata === 'object' && !Array.isArray(input.metadata) ? input.metadata as Record<string, unknown> : {},
		};
		const validation = validateCapacityAllocationSetV2(candidate);
		if (validation.ok) validation.diagnostics.push(...await this.validateReferences(candidate));
		validation.ok = validation.diagnostics.length === 0;
		return { candidate, validation };
	}

	async create(teamId: string, input: Record<string, unknown>, createdById: string | null, idempotencyKey: string) {
		const operation = { teamId, operation: 'capacity-allocation.create', idempotencyKey, request: { input, createdById } };
		const replay = await this.operationReceipts.replay<CapacityAllocationSetV2>(operation);
		if (replay.found) return replay.response;
		const plan = await this.plan(teamId, input, createdById);
		if (!plan.validation.ok) throw new CapacityAllocationPolicyError(plan.validation.diagnostics);
		const now = new Date().toISOString();
		const persisted = {
			...plan.candidate,
			activatedAt: plan.candidate.activatedAt ?? null,
			supersededById: plan.candidate.supersededById ?? null,
			createdAt: now,
			updatedAt: now,
		};
		try {
			return await this.repository.create(persisted, [
				this.operationReceipts.insertOperation(operation, 'capacity-allocation-set', persisted.id, persisted, now),
			]);
		} catch (error) {
			const raced = await this.operationReceipts.replay<CapacityAllocationSetV2>(operation);
			if (raced.found) return raced.response;
			throw error;
		}
	}

	async activate(teamId: string, allocationSetId: string, idempotencyKey: string) {
		const operation = { teamId, operation: 'capacity-allocation.activate', idempotencyKey, request: { allocationSetId } };
		const replay = await this.operationReceipts.replay<CapacityAllocationSetV2 | null>(operation);
		if (replay.found) return replay.response;
		const existing = await this.repository.get(teamId, allocationSetId);
		if (!existing) return null;
		if (existing.status !== 'draft' && existing.status !== 'validated') {
			throw new CapacityAllocationPolicyError([], 'capacity_allocation_transition_invalid', 409, `Allocation set in ${existing.status} state cannot be activated.`);
		}
		const validation = validateCapacityAllocationSetV2({ ...existing, status: 'active' });
		validation.diagnostics.push(...await this.validateReferences(existing));
		validation.ok = validation.diagnostics.length === 0;
		if (!validation.ok) throw new CapacityAllocationPolicyError(validation.diagnostics);
		const now = new Date().toISOString();
		const response: CapacityAllocationSetV2 = {
			...existing,
			status: 'active',
			activatedAt: existing.activatedAt ?? now,
			supersededById: null,
			updatedAt: now,
		};
		const receipt = this.operationReceipts.insertOperationWhen(
			operation,
			'capacity-allocation-set',
			allocationSetId,
			response,
			now,
			`SELECT 1 FROM capacity_allocation_sets WHERE id = ? AND team_id = ? AND status = 'active'`,
			[allocationSetId, teamId],
		);
		try {
			return await this.repository.activate(teamId, allocationSetId, existing.status, [receipt], now);
		} catch (error) {
			const raced = await this.operationReceipts.replay<CapacityAllocationSetV2>(operation);
			if (raced.found) return raced.response;
			throw error;
		}
	}

	async supersede(teamId: string, allocationSetId: string, expectedActiveAllocationSetId: string | null | undefined, idempotencyKey: string) {
		const operation = {
			teamId,
			operation: 'capacity-allocation.supersede',
			idempotencyKey,
			request: { allocationSetId, expectedActiveAllocationSetId: expectedActiveAllocationSetId ?? null },
		};
		const replay = await this.operationReceipts.replay<{ superseded: CapacityAllocationSetV2 | null; active: CapacityAllocationSetV2 | null }>(operation);
		if (replay.found) return replay.response;
		const active = await this.repository.getActive(teamId);
		if (expectedActiveAllocationSetId && active?.id !== expectedActiveAllocationSetId) {
			throw new CapacityGovernanceError(
				'capacity_allocation_supersession_conflict',
				'The active allocation set changed before supersession.',
				409,
				{ expectedActiveAllocationSetId, activeAllocationSetId: active?.id ?? null },
			);
		}
		const replacement = await this.repository.get(teamId, allocationSetId);
		if (!replacement) return { superseded: active, active: null };
		if (replacement.status !== 'draft' && replacement.status !== 'validated') {
			throw new CapacityAllocationPolicyError([], 'capacity_allocation_transition_invalid', 409, `Allocation set in ${replacement.status} state cannot be activated.`);
		}
		const validation = validateCapacityAllocationSetV2({ ...replacement, status: 'active' });
		validation.diagnostics.push(...await this.validateReferences(replacement));
		validation.ok = validation.diagnostics.length === 0;
		if (!validation.ok) throw new CapacityAllocationPolicyError(validation.diagnostics);
		const now = new Date().toISOString();
		const activated: CapacityAllocationSetV2 = {
			...replacement,
			status: 'active',
			activatedAt: replacement.activatedAt ?? now,
			supersededById: null,
			updatedAt: now,
		};
		const superseded = active && active.id !== activated.id
			? { ...active, status: 'superseded' as const, supersededById: activated.id, updatedAt: now }
			: null;
		const response = { superseded, active: activated };
		const receipt = this.operationReceipts.insertOperationWhen(
			operation,
			'capacity-allocation-set',
			allocationSetId,
			response,
			now,
			`SELECT 1 FROM capacity_allocation_sets WHERE id = ? AND team_id = ? AND status = 'active'`,
			[allocationSetId, teamId],
		);
		try {
			await this.repository.activate(teamId, allocationSetId, replacement.status, [receipt], now, active?.id ?? null);
			return response;
		} catch (error) {
			const raced = await this.operationReceipts.replay<typeof response>(operation);
			if (raced.found) return raced.response;
			throw error;
		}
	}

	async archive(teamId: string, allocationSetId: string, idempotencyKey: string) {
		const operation = { teamId, operation: 'capacity-allocation.archive', idempotencyKey, request: { allocationSetId } };
		const replay = await this.operationReceipts.replay<CapacityAllocationSetV2 | null>(operation);
		if (replay.found) return replay.response;
		const existing = await this.repository.get(teamId, allocationSetId);
		if (!existing) return null;
		if (existing.status === 'active') {
			throw new CapacityGovernanceError('capacity_allocation_active_archive_denied', 'Activate a replacement allocation before archiving the active allocation.', 409);
		}
		const now = new Date().toISOString();
		const response = existing.status === 'archived' ? existing : { ...existing, status: 'archived' as const, updatedAt: now };
		if (existing.status === 'archived') {
			await this.database.batch([this.operationReceipts.insertOperation(operation, 'capacity-allocation-set', allocationSetId, response, now)]);
			return response;
		}
		const receipt = this.operationReceipts.insertOperationWhen(
			operation,
			'capacity-allocation-set',
			allocationSetId,
			response,
			now,
			`SELECT 1 FROM capacity_allocation_sets WHERE id = ? AND team_id = ? AND status = 'archived'`,
			[allocationSetId, teamId],
		);
		try {
			return await this.repository.archive(teamId, allocationSetId, [receipt], now);
		} catch (error) {
			const raced = await this.operationReceipts.replay<CapacityAllocationSetV2>(operation);
			if (raced.found) return raced.response;
			throw error;
		}
	}
}
