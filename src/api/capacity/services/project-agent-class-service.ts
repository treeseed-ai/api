import type { ProjectAgentClass, ProjectAgentClassStatus } from '@treeseed/sdk/agent-capacity';
import type { CapacityPageCursor } from '@treeseed/sdk/capacity-pagination';
import { randomUUID } from 'node:crypto';
import type { CapacityGovernanceDatabase } from '../database.ts';
import { CapacityGovernanceError } from '../database.ts';
import { ProjectAgentClassRepository } from '../repositories/project-agent-class.ts';
import { CapacityOperationReceiptRepository } from '../repositories/operation-receipt.ts';
import { validateProjectAgentActivityRefs } from './project-agent-activity-refs.ts';

type JsonRecord = Record<string, unknown>;
const STATUSES = new Set<ProjectAgentClassStatus>(['active', 'paused', 'archived']);

function object(value: unknown): JsonRecord { return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {}; }
function strings(value: unknown): string[] { return Array.isArray(value) ? [...new Set(value.map(String).map((item) => item.trim()).filter(Boolean))] : []; }
function slug(value: unknown): string { return String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9_-]+/gu, '-').replace(/^-+|-+$/gu, '') || 'agent-class'; }

interface ProjectAgentClassStore extends CapacityGovernanceDatabase {
	getProject(projectId: string): Promise<{ id: string; teamId: string } | null>;
}

export class ProjectAgentClassService {
	private readonly repository: ProjectAgentClassRepository;
	private readonly operationReceipts: CapacityOperationReceiptRepository;
	constructor(private readonly store: ProjectAgentClassStore) {
		this.repository = new ProjectAgentClassRepository(store);
		this.operationReceipts = new CapacityOperationReceiptRepository(store);
	}

	get(projectId: string, classId: string) { return this.repository.get(projectId, classId); }
	listPage(projectId: string, page: { limit: number; cursor: CapacityPageCursor | null }) { return this.repository.listPage(projectId, page); }

	async create(projectId: string, input: JsonRecord, idempotencyKey: string) {
		const project = await this.store.getProject(projectId);
		if (!project) return null;
		const operation = { teamId: project.teamId, operation: 'project-agent-class.create', idempotencyKey, request: { projectId, input } };
		const replay = await this.operationReceipts.replay<ProjectAgentClass>(operation);
		if (replay.found) return replay.response;
		const classSlug = slug(input.slug ?? input.name);
		const id = typeof input.id === 'string' && input.id.trim() ? input.id.trim() : `${projectId}:${classSlug}:${randomUUID().slice(0, 8)}`;
		const idOwner = await this.repository.getById(id);
		if (idOwner || await this.repository.getBySlug(projectId, classSlug)) throw new CapacityGovernanceError('project_agent_class_conflict', 'Project agent class id or slug already exists.', 409, { projectId, id, slug: classSlug, idOwnerProjectId: idOwner?.projectId ?? null });
		const now = new Date().toISOString();
		const value = { ...this.value(project.teamId, projectId, id, classSlug, input), createdAt: now, updatedAt: now };
		try {
			return await this.repository.create(value, [
				this.operationReceipts.insertOperation(operation, 'project-agent-class', id, value, now),
			], now);
		} catch (error) {
			const raced = await this.operationReceipts.replay<ProjectAgentClass>(operation);
			if (raced.found) return raced.response;
			throw error;
		}
	}

	async update(projectId: string, classId: string, input: JsonRecord, idempotencyKey: string) {
		const existing = await this.repository.get(projectId, classId);
		if (!existing) return null;
		const operation = { teamId: existing.teamId, operation: 'project-agent-class.update', idempotencyKey, request: { projectId, classId, input } };
		const replay = await this.operationReceipts.replay<ProjectAgentClass>(operation);
		if (replay.found) return replay.response;
		const nextSlug = input.slug === undefined ? existing.slug : slug(input.slug);
		const duplicate = await this.repository.getBySlug(projectId, nextSlug);
		if (duplicate && duplicate.id !== classId) throw new CapacityGovernanceError('project_agent_class_conflict', 'Project agent class slug already exists.', 409, { projectId, classId, slug: nextSlug });
		const now = new Date().toISOString();
		const value = { ...this.value(existing.teamId, projectId, classId, nextSlug, { ...existing, ...input }), createdAt: existing.createdAt, updatedAt: now };
		const receipt = this.operationReceipts.insertOperationWhen(
			operation,
			'project-agent-class',
			classId,
			value,
			now,
			'SELECT 1 FROM project_agent_classes WHERE id = ? AND project_id = ? AND updated_at = ?',
			[classId, projectId, now],
		);
		try {
			return await this.repository.update(value, [receipt], now);
		} catch (error) {
			const raced = await this.operationReceipts.replay<ProjectAgentClass>(operation);
			if (raced.found) return raced.response;
			throw error;
		}
	}

	private value(teamId: string, projectId: string, id: string, classSlug: string, input: JsonRecord): ProjectAgentClass {
		const candidateStatus = String(input.status ?? 'active') as ProjectAgentClassStatus;
		if (!STATUSES.has(candidateStatus)) throw new CapacityGovernanceError('project_agent_class_status_invalid', `Unknown project agent class status ${candidateStatus}.`, 400);
		const allowedModes = strings(input.allowedModes ?? input.allowed_modes);
		const modes = allowedModes.length ? allowedModes : ['planning', 'acting'];
		if (modes.some((mode) => mode !== 'planning' && mode !== 'acting')) throw new CapacityGovernanceError('project_agent_class_modes_invalid', 'allowedModes must contain only planning and/or acting.', 400);
		const handlerRefs = object(input.handlerRefs ?? input.handler_refs);
		const handlerRefIssues = validateProjectAgentActivityRefs(handlerRefs);
		if (handlerRefIssues.length) throw new CapacityGovernanceError('project_agent_activity_refs_invalid', 'Project agent activity references are invalid.', 400, { diagnostics: handlerRefIssues });
		return {
			id, teamId, projectId, slug: classSlug, name: String(input.name ?? classSlug).trim() || classSlug, status: candidateStatus,
			allowedModes: modes as ProjectAgentClass['allowedModes'], requiredCapabilities: strings(input.requiredCapabilities ?? input.required_capabilities),
			kernelProfile: object(input.kernelProfile ?? input.kernel_profile), kernelPolicy: object(input.kernelPolicy ?? input.kernel_policy),
			handlerRefs, outputContracts: object(input.outputContracts ?? input.output_contracts), metadata: object(input.metadata),
		};
	}
}
