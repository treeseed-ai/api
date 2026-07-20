import { createHash, randomUUID } from 'node:crypto';
import type {
	AgentFallbackOutput,
	TreeDxProjectProxyAuditRecord,
	TreeDxProxyHandle,
} from '@treeseed/sdk/agent-capacity';
import {
	encodeCapacityPageCursor,
	normalizeCapacityPageLimit,
	type CapacityPage,
	type CapacityPageCursor,
} from '@treeseed/sdk/capacity-pagination';
import type { CapacityGovernanceDatabase } from '../database.ts';
import { CapacityGovernanceError } from '../database.ts';

type JsonRecord = Record<string, unknown>;

export interface AgentFallbackOutputWrite {
	id?: string;
	projectId: string;
	assignmentId?: string | null;
	mode?: string;
	code?: string;
	status?: string;
	output?: JsonRecord;
	provenance?: JsonRecord;
	quota?: JsonRecord;
	metadata?: JsonRecord;
}

export interface AgentFallbackOutputFilters {
	assignmentId?: string | null;
	status?: string | null;
	mode?: string | null;
	limit?: unknown;
	cursor?: CapacityPageCursor | null;
}

export interface TreeDxProxyAuditWrite {
	id?: string;
	teamId: string;
	projectId: string;
	assignmentId?: string | null;
	actorType?: string;
	actorId?: string | null;
	method?: string;
	path?: string;
	handle?: JsonRecord;
	resultStatus?: string;
	reasonCode?: string | null;
	reason?: string | null;
	metadata?: JsonRecord;
}

export interface TreeDxProxyAuditFilters {
	assignmentId?: string | null;
	actorType?: string | null;
	limit?: unknown;
	cursor?: CapacityPageCursor | null;
}

export interface TreeDxProxyHandleWrite {
	id?: string;
	projectId: string;
	assignmentId?: string | null;
	repositoryId?: string | null;
	workspaceId?: string | null;
	status?: string;
	scopes?: unknown[];
	allowedOperations?: unknown[];
	allowedPaths?: unknown[];
	allowedReadPaths?: unknown[];
	allowedWritePaths?: unknown[];
	token?: string | null;
	tokenHash?: string | null;
	expiresAt?: string | null;
	issuedAt?: string | null;
	revokedAt?: string | null;
	metadata?: JsonRecord;
}

interface ProjectIdentityRow extends JsonRecord {
	id: string;
	team_id: string;
}

function json<T>(value: unknown, fallback: T): T {
	if (typeof value !== 'string' || !value) return fallback;
	try {
		return JSON.parse(value) as T;
	} catch {
		return fallback;
	}
}

function record(value: unknown): JsonRecord {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

function strings(value: unknown): string[] {
	return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

function stringValue(value: unknown, fallback: string): string {
	return typeof value === 'string' && value ? value : fallback;
}

function fallbackOutput(row: JsonRecord | null): AgentFallbackOutput | null {
	if (!row) return null;
	return {
		id: String(row.id),
		teamId: String(row.team_id),
		projectId: String(row.project_id),
		assignmentId: row.assignment_id ? String(row.assignment_id) : null,
		mode: String(row.mode) as AgentFallbackOutput['mode'],
		code: String(row.code),
		status: String(row.status),
		output: json(row.output_json, {}),
		provenance: json(row.provenance_json, {}),
		quota: json(row.quota_json, {}),
		metadata: json(row.metadata_json, {}),
		createdAt: String(row.created_at),
	};
}

function proxyAudit(row: JsonRecord): TreeDxProjectProxyAuditRecord & { reasonCode: string | null; reason: string | null } {
	return {
		id: String(row.id),
		teamId: String(row.team_id),
		projectId: String(row.project_id),
		assignmentId: row.assignment_id ? String(row.assignment_id) : null,
		actorType: String(row.actor_type),
		actorId: row.actor_id ? String(row.actor_id) : null,
		method: String(row.method),
		path: String(row.path),
		handle: json(row.handle_json, {}),
		resultStatus: String(row.result_status),
		reasonCode: row.reason_code ? String(row.reason_code) : null,
		reason: row.reason ? String(row.reason) : null,
		metadata: json(row.metadata_json, {}),
		createdAt: String(row.created_at),
	};
}

function proxyHandle(row: JsonRecord | null): TreeDxProxyHandle | null {
	if (!row) return null;
	return {
		id: String(row.id),
		teamId: String(row.team_id),
		projectId: String(row.project_id),
		assignmentId: row.assignment_id ? String(row.assignment_id) : null,
		repositoryId: row.repository_id ? String(row.repository_id) : null,
		workspaceId: row.workspace_id ? String(row.workspace_id) : null,
		status: String(row.status),
		scopes: json(row.scopes_json, []),
		allowedOperations: json(row.allowed_operations_json, []),
		allowedPaths: json(row.allowed_paths_json, []),
		allowedReadPaths: json(row.allowed_read_paths_json, []),
		allowedWritePaths: json(row.allowed_write_paths_json, []),
		tokenHash: row.token_hash ? String(row.token_hash) : null,
		expiresAt: row.expires_at ? String(row.expires_at) : null,
		issuedAt: row.issued_at ? String(row.issued_at) : null,
		revokedAt: row.revoked_at ? String(row.revoked_at) : null,
		metadata: json(row.metadata_json, {}),
	};
}

function page<T>(rows: JsonRecord[], limit: number, serialize: (row: JsonRecord) => T): CapacityPage<T> {
	const hasMore = rows.length > limit;
	const selected = rows.slice(0, limit);
	const last = selected.at(-1);
	return {
		items: selected.map(serialize),
		page: {
			limit,
			hasMore,
			nextCursor: hasMore && last
				? encodeCapacityPageCursor({ createdAt: String(last.created_at), id: String(last.id) })
				: null,
		},
	};
}

export class CapacityRuntimeEvidenceRepository {
	constructor(private readonly database: CapacityGovernanceDatabase) {}

	private async ready(): Promise<void> {
		await this.database.ensureInitialized();
	}

	private async project(projectId: string): Promise<ProjectIdentityRow | null> {
		return this.database.first<ProjectIdentityRow>(
			`SELECT id, team_id FROM projects WHERE id = ? LIMIT 1`,
			[projectId],
		);
	}

	async recordFallbackOutput(input: AgentFallbackOutputWrite): Promise<AgentFallbackOutput> {
		await this.ready();
		const project = await this.project(input.projectId);
		if (!project) throw new CapacityGovernanceError('agent_fallback_project_not_found', 'Fallback output project does not exist.', 404, { projectId: input.projectId });
		const timestamp = new Date().toISOString();
		const id = input.id ?? (input.assignmentId
			? `fallback_${createHash('sha256').update(JSON.stringify({ assignmentId: input.assignmentId, mode: input.mode ?? 'planning', code: input.code ?? 'fallback_output' })).digest('hex').slice(0, 24)}`
			: randomUUID());
		const existing = await this.database.first(`SELECT * FROM agent_fallback_outputs WHERE id = ?`, [id]);
		if (existing) {
			if (
				String(existing.project_id) !== input.projectId
				|| String(existing.assignment_id ?? '') !== String(input.assignmentId ?? '')
				|| String(existing.mode) !== stringValue(input.mode, 'planning')
				|| String(existing.code) !== stringValue(input.code, 'fallback_output')
			) {
				throw new CapacityGovernanceError('agent_fallback_id_conflict', 'Fallback output id is already owned by different execution evidence.', 409, { id });
			}
			return fallbackOutput(existing) as AgentFallbackOutput;
		}
		await this.database.run(
			`INSERT INTO agent_fallback_outputs (
				id, team_id, project_id, assignment_id, mode, code, status, output_json, provenance_json, quota_json, metadata_json, created_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT (id) DO NOTHING`,
			[
				id,
				project.team_id,
				project.id,
				input.assignmentId ?? null,
				stringValue(input.mode, 'planning'),
				stringValue(input.code, 'fallback_output'),
				stringValue(input.status, 'draft'),
				JSON.stringify(record(input.output)),
				JSON.stringify(record(input.provenance)),
				JSON.stringify(record(input.quota)),
				JSON.stringify(record(input.metadata)),
				timestamp,
			],
		);
		const persisted = await this.database.first(`SELECT * FROM agent_fallback_outputs WHERE id = ?`, [id]);
		if (!persisted) throw new CapacityGovernanceError('agent_fallback_not_persisted', 'Fallback output was not persisted.', 500, { id });
		if (
			String(persisted.project_id) !== input.projectId
			|| String(persisted.assignment_id ?? '') !== String(input.assignmentId ?? '')
			|| String(persisted.mode) !== stringValue(input.mode, 'planning')
			|| String(persisted.code) !== stringValue(input.code, 'fallback_output')
		) {
			throw new CapacityGovernanceError('agent_fallback_id_conflict', 'Fallback output id was concurrently claimed by different execution evidence.', 409, { id });
		}
		return fallbackOutput(persisted) as AgentFallbackOutput;
	}

	async listFallbackOutputs(projectId: string, filters: AgentFallbackOutputFilters = {}): Promise<CapacityPage<AgentFallbackOutput>> {
		await this.ready();
		const clauses = ['project_id = ?'];
		const values: unknown[] = [projectId];
		if (filters.assignmentId) {
			clauses.push('assignment_id = ?');
			values.push(filters.assignmentId);
		}
		if (filters.status) {
			clauses.push('status = ?');
			values.push(filters.status);
		}
		if (filters.mode) {
			clauses.push('mode = ?');
			values.push(filters.mode);
		}
		if (filters.cursor) {
			clauses.push('(created_at < ? OR (created_at = ? AND id < ?))');
			values.push(filters.cursor.createdAt, filters.cursor.createdAt, filters.cursor.id);
		}
		const limit = normalizeCapacityPageLimit(filters.limit);
		const rows = await this.database.all(
			`SELECT * FROM agent_fallback_outputs WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ?`,
			[...values, limit + 1],
		);
		return page(rows, limit, (row) => fallbackOutput(row) as AgentFallbackOutput);
	}

	async recordProxyAudit(input: TreeDxProxyAuditWrite): Promise<{ id: string; createdAt: string }> {
		await this.ready();
		const timestamp = new Date().toISOString();
		const id = input.id ?? randomUUID();
		await this.database.run(
			`INSERT INTO treedx_project_proxy_audit (
				id, team_id, project_id, assignment_id, actor_type, actor_id, method, path, handle_json, result_status,
				reason_code, reason, metadata_json, created_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				id,
				input.teamId,
				input.projectId,
				input.assignmentId ?? null,
				stringValue(input.actorType, 'user'),
				input.actorId ?? null,
				stringValue(input.method, 'GET'),
				stringValue(input.path, '/'),
				JSON.stringify(record(input.handle)),
				stringValue(input.resultStatus, 'observed'),
				input.reasonCode ?? null,
				input.reason ?? null,
				JSON.stringify(record(input.metadata)),
				timestamp,
			],
		);
		return { id, createdAt: timestamp };
	}

	async issueProxyHandle(input: TreeDxProxyHandleWrite): Promise<TreeDxProxyHandle | null> {
		await this.ready();
		const project = await this.project(input.projectId);
		if (!project) return null;
		const timestamp = new Date().toISOString();
		const id = input.id ?? randomUUID();
		const token = stringValue(input.token, '');
		await this.database.run(
			`INSERT OR REPLACE INTO treedx_proxy_handles (
				id, team_id, project_id, assignment_id, repository_id, workspace_id, status, scopes_json,
				allowed_operations_json, allowed_paths_json, allowed_read_paths_json, allowed_write_paths_json,
				token_hash, expires_at, issued_at, revoked_at,
				metadata_json, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
				?, COALESCE((SELECT created_at FROM treedx_proxy_handles WHERE id = ?), ?), ?)`,
			[
				id,
				project.team_id,
				project.id,
				input.assignmentId ?? null,
				input.repositoryId ?? null,
				input.workspaceId ?? null,
				stringValue(input.status, 'issued'),
				JSON.stringify(strings(input.scopes)),
				JSON.stringify(strings(input.allowedOperations)),
				JSON.stringify(strings(input.allowedPaths)),
				JSON.stringify(strings(input.allowedReadPaths)),
				JSON.stringify(strings(input.allowedWritePaths)),
				token ? createHash('sha256').update(token).digest('hex') : input.tokenHash ?? null,
				input.expiresAt ?? null,
				input.issuedAt ?? timestamp,
				input.revokedAt ?? null,
				JSON.stringify(record(input.metadata)),
				id,
				timestamp,
				timestamp,
			],
		);
		return this.getProxyHandle(project.team_id, project.id, id);
	}

	async getProxyHandle(teamId: string, projectId: string, handleId: string): Promise<TreeDxProxyHandle | null> {
		await this.ready();
		return proxyHandle(await this.database.first(
			`SELECT * FROM treedx_proxy_handles WHERE id = ? AND team_id = ? AND project_id = ? LIMIT 1`,
			[handleId, teamId, projectId],
		));
	}

	async revokeProxyHandle(
		teamId: string,
		projectId: string,
		handleId: string,
		input: { metadata?: JsonRecord } = {},
	): Promise<TreeDxProxyHandle | null> {
		await this.ready();
		const timestamp = new Date().toISOString();
		await this.database.run(
			`UPDATE treedx_proxy_handles
			 SET status = 'revoked', revoked_at = COALESCE(revoked_at, ?), metadata_json = ?, updated_at = ?
			 WHERE id = ? AND team_id = ? AND project_id = ?`,
			[timestamp, JSON.stringify(record(input.metadata)), timestamp, handleId, teamId, projectId],
		);
		return this.getProxyHandle(teamId, projectId, handleId);
	}

	async listProxyAudit(projectId: string, filters: TreeDxProxyAuditFilters = {}): Promise<CapacityPage<TreeDxProjectProxyAuditRecord>> {
		await this.ready();
		const clauses = ['project_id = ?'];
		const values: unknown[] = [projectId];
		if (filters.assignmentId) {
			clauses.push('assignment_id = ?');
			values.push(filters.assignmentId);
		}
		if (filters.actorType) {
			clauses.push('actor_type = ?');
			values.push(filters.actorType);
		}
		if (filters.cursor) {
			clauses.push('(created_at < ? OR (created_at = ? AND id < ?))');
			values.push(filters.cursor.createdAt, filters.cursor.createdAt, filters.cursor.id);
		}
		const limit = normalizeCapacityPageLimit(filters.limit);
		const rows = await this.database.all(
			`SELECT * FROM treedx_project_proxy_audit WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ?`,
			[...values, limit + 1],
		);
		return page(rows, limit, proxyAudit);
	}
}
