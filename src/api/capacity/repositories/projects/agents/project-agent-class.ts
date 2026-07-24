import type { ProjectAgentClass, ProjectAgentClassStatus } from '@treeseed/sdk/agent-capacity';
import { encodeCapacityPageCursor, type CapacityPage, type CapacityPageCursor } from '@treeseed/sdk/capacity-pagination';
import { decodeDurableJsonArray, decodeDurableJsonObject } from '../../../durable-json.ts';
import type { CapacityDatabaseOperation, CapacityGovernanceDatabase } from '../../../database.ts';
import { CapacityGovernanceError } from '../../../database.ts';

type Row = Record<string, unknown>;
const STATUSES = new Set<ProjectAgentClassStatus>(['active', 'paused', 'archived']);

function text(value: unknown) { return value == null ? '' : String(value); }
function context(id: string, column: string) { return { owner: 'project agent class', ownerId: id, column }; }

function status(value: unknown, id: string): ProjectAgentClassStatus {
	const candidate = text(value) as ProjectAgentClassStatus;
	if (!STATUSES.has(candidate)) throw new CapacityGovernanceError('project_agent_class_status_invalid', `Project agent class ${id} has invalid status ${candidate || '(empty)'}.`, 500, { projectAgentClassId: id });
	return candidate;
}

export function serializeProjectAgentClassRow(row: Row | null): ProjectAgentClass | null {
	if (!row) return null;
	const id = text(row.id);
	for (const [field, value] of [['id', id], ['teamId', row.team_id], ['projectId', row.project_id], ['slug', row.slug], ['name', row.name]] as const) {
		if (!text(value)) throw new CapacityGovernanceError('project_agent_class_record_invalid', `Project agent class ${id || '(unknown)'} requires ${field}.`, 500, { projectAgentClassId: id || null, field });
	}
	const allowedModes = decodeDurableJsonArray<string>(row.allowed_modes_json, context(id, 'allowed_modes_json'));
	if (allowedModes.length === 0 || allowedModes.some((mode) => mode !== 'planning' && mode !== 'acting') || new Set(allowedModes).size !== allowedModes.length) {
		throw new CapacityGovernanceError('project_agent_class_modes_invalid', `Project agent class ${id} has invalid allowed modes.`, 500, { projectAgentClassId: id });
	}
	const requiredCapabilities = decodeDurableJsonArray<string>(row.required_capabilities_json, context(id, 'required_capabilities_json'));
	if (requiredCapabilities.some((capability) => typeof capability !== 'string' || !capability.trim()) || new Set(requiredCapabilities).size !== requiredCapabilities.length) {
		throw new CapacityGovernanceError('project_agent_class_capabilities_invalid', `Project agent class ${id} has invalid required capabilities.`, 500, { projectAgentClassId: id });
	}
	return {
		id, teamId: text(row.team_id), projectId: text(row.project_id), slug: text(row.slug), name: text(row.name), status: status(row.status, id),
		allowedModes: allowedModes as ProjectAgentClass['allowedModes'], requiredCapabilities,
		kernelProfile: decodeDurableJsonObject(row.kernel_profile_json, context(id, 'kernel_profile_json')),
		kernelPolicy: decodeDurableJsonObject(row.kernel_policy_json, context(id, 'kernel_policy_json')),
		handlerRefs: decodeDurableJsonObject(row.handler_refs_json, context(id, 'handler_refs_json')),
		outputContracts: decodeDurableJsonObject(row.output_contracts_json, context(id, 'output_contracts_json')),
		metadata: decodeDurableJsonObject(row.metadata_json, context(id, 'metadata_json')),
		createdAt: text(row.created_at), updatedAt: text(row.updated_at),
	};
}

export class ProjectAgentClassRepository {
	constructor(private readonly database: CapacityGovernanceDatabase) {}

	async getById(classId: string) {
		await this.database.ensureInitialized();
		return serializeProjectAgentClassRow(await this.database.first(`SELECT * FROM project_agent_classes WHERE id = ? LIMIT 1`, [classId]));
	}

	async get(projectId: string, classId: string) {
		await this.database.ensureInitialized();
		return serializeProjectAgentClassRow(await this.database.first(`SELECT * FROM project_agent_classes WHERE project_id = ? AND id = ? LIMIT 1`, [projectId, classId]));
	}

	async getBySlug(projectId: string, slug: string) {
		await this.database.ensureInitialized();
		return serializeProjectAgentClassRow(await this.database.first(`SELECT * FROM project_agent_classes WHERE project_id = ? AND slug = ? LIMIT 1`, [projectId, slug]));
	}

	async listPage(projectId: string, page: { limit: number; cursor: CapacityPageCursor | null }): Promise<CapacityPage<ProjectAgentClass>> {
		await this.database.ensureInitialized();
		const clauses = ['project_id = ?'];
		const values: unknown[] = [projectId];
		if (page.cursor) { clauses.push('(created_at > ? OR (created_at = ? AND id > ?))'); values.push(page.cursor.createdAt, page.cursor.createdAt, page.cursor.id); }
		values.push(page.limit + 1);
		const rows = await this.database.all(`SELECT * FROM project_agent_classes WHERE ${clauses.join(' AND ')} ORDER BY created_at ASC, id ASC LIMIT ?`, values);
		const hasMore = rows.length > page.limit;
		const selected = rows.slice(0, page.limit);
		const last = selected.at(-1);
		return { items: selected.map((row) => serializeProjectAgentClassRow(row) as ProjectAgentClass), page: { limit: page.limit, hasMore, nextCursor: hasMore && last ? encodeCapacityPageCursor({ createdAt: text(last.created_at), id: text(last.id) }) : null } };
	}

	async create(value: ProjectAgentClass, operations: CapacityDatabaseOperation[] = [], now = new Date().toISOString()): Promise<ProjectAgentClass> {
		await this.database.ensureInitialized();
		await this.database.batch([
			{ query: `INSERT INTO project_agent_classes (id, team_id, project_id, slug, name, status, allowed_modes_json, required_capabilities_json, kernel_profile_json, kernel_policy_json, handler_refs_json, output_contracts_json, metadata_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, params: [value.id, value.teamId, value.projectId, value.slug, value.name, value.status, JSON.stringify(value.allowedModes), JSON.stringify(value.requiredCapabilities), JSON.stringify(value.kernelProfile), JSON.stringify(value.kernelPolicy), JSON.stringify(value.handlerRefs), JSON.stringify(value.outputContracts), JSON.stringify(value.metadata ?? {}), now, now] },
			...operations,
		]);
		return this.required(value.projectId, value.id);
	}

	async update(value: ProjectAgentClass, operations: CapacityDatabaseOperation[] = [], now = new Date().toISOString()): Promise<ProjectAgentClass> {
		await this.database.ensureInitialized();
		await this.database.batch([
			{ query: `UPDATE project_agent_classes SET slug = ?, name = ?, status = ?, allowed_modes_json = ?, required_capabilities_json = ?, kernel_profile_json = ?, kernel_policy_json = ?, handler_refs_json = ?, output_contracts_json = ?, metadata_json = ?, updated_at = ? WHERE id = ? AND project_id = ?`, params: [value.slug, value.name, value.status, JSON.stringify(value.allowedModes), JSON.stringify(value.requiredCapabilities), JSON.stringify(value.kernelProfile), JSON.stringify(value.kernelPolicy), JSON.stringify(value.handlerRefs), JSON.stringify(value.outputContracts), JSON.stringify(value.metadata ?? {}), now, value.id, value.projectId] },
			...operations,
		]);
		return this.required(value.projectId, value.id);
	}

	private async required(projectId: string, id: string) {
		const value = await this.get(projectId, id);
		if (!value) throw new CapacityGovernanceError('project_agent_class_persistence_failed', 'Project agent class persistence postcondition failed.', 500, { projectAgentClassId: id });
		return value;
	}
}
