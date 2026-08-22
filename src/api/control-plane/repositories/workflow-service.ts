import { randomUUID } from 'node:crypto';
import { githubActionsRequest, reconciledWorkflowRunStatus, repositoryPath } from '../../../providers/github/actions-client.ts';
import { resolveWorkflowRunAuthority } from '../../../providers/github/workflow-authority.ts';
import { WorkflowOperationError } from './workflow-operation-error.ts';

type Principal = { id: string; roles?: string[]; permissions?: string[] } | undefined;
const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';
const object = (value: unknown) => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const array = (value: unknown) => Array.isArray(value) ? value : [];
const parse = (value: unknown, fallback: unknown) => { try { return JSON.parse(String(value ?? JSON.stringify(fallback))); } catch { return fallback; } };

function limit(value: unknown, fallback: number) {
	const parsed = Number(value ?? fallback);
	if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 100) throw new WorkflowOperationError(400, 'workflow_limit_invalid', 'Workflow limits must be whole numbers from 1 through 100.');
	return parsed;
}

function decodeRunCursor(value: unknown) {
	if (!value) return null;
	try {
		const decoded = JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8'));
		if (typeof decoded.createdAt === 'string' && typeof decoded.id === 'string') return decoded as { createdAt: string; id: string };
	} catch { /* invalid cursor */ }
	throw new WorkflowOperationError(400, 'workflow_cursor_invalid', 'The workflow cursor is invalid.');
}

const encodeRunCursor = (row: any) => Buffer.from(JSON.stringify({ createdAt: row.created_at, id: row.id })).toString('base64url');

export function serializeWorkflowOperation(row: any) {
	if (!row) return null;
	return { id: row.id, projectId: row.project_id, teamId: row.team_id, workflowBindingId: row.workflow_binding_id,
		repositoryBindingId: row.repository_binding_id, workflowId: row.workflow_id, refPolicy: parse(row.ref_policy_json, []),
		allowedInputs: parse(row.allowed_inputs_json, {}), requiredSecrets: parse(row.required_secrets_json, []),
		requiredVariables: parse(row.required_variables_json, []), actorPolicy: parse(row.actor_policy_json, []),
		modePolicy: parse(row.mode_policy_json, []), version: Number(row.version), createdAt: row.created_at, updatedAt: row.updated_at };
}

export function serializeWorkflowOperationRun(row: any) {
	if (!row) return null;
	return { id: row.id, operationId: row.operation_id, projectId: row.project_id, teamId: row.team_id,
		actorType: row.actor_type, actorId: row.actor_id, mode: row.mode, assignmentId: row.assignment_id, handleId: row.handle_id,
		providerId: row.provider_id, providerRunId: row.provider_run_id, providerRunUrl: row.provider_run_url,
		sourceSha: row.source_sha, ref: row.ref, correlationId: row.correlation_id, status: row.status,
		artifacts: parse(row.artifacts_json, []), createdAt: row.created_at, updatedAt: row.updated_at };
}

export async function observeWorkflowRun(store: any, row: any, fetchImpl: typeof fetch = fetch) {
	if (!row?.provider_run_id) return row;
	const provider = await resolveWorkflowRunAuthority({ store, run: row, fetchImpl });
	const live: any = await githubActionsRequest(fetchImpl, provider.credential.token,
		`${repositoryPath(provider.repository.owner, provider.repository.name)}/actions/runs/${encodeURIComponent(row.provider_run_id)}`);
	const status = reconciledWorkflowRunStatus(String(row.status ?? ''), String(live.status ?? ''), live.conclusion ?? null);
	await store.run('UPDATE workflow_operation_runs SET provider_run_url = ?, status = ?, updated_at = ? WHERE id = ?',
		[live.html_url ?? row.provider_run_url, status, new Date().toISOString(), row.id]);
	return store.first('SELECT * FROM workflow_operation_runs WHERE id = ?', [row.id]);
}

function validateInputs(definition: any, supplied: unknown) {
	const inputs = object(supplied);
	if ('treeseed_operation_correlation' in inputs) return { error: 'The operation correlation input is reserved.', inputs: {} };
	const contract = object(definition.allowedInputs);
	const unknown = Object.keys(inputs).filter((name) => !(name in contract));
	if (unknown.length) return { error: `Unsupported workflow inputs: ${unknown.join(', ')}.`, inputs: {} };
	const normalized: Record<string, string> = {};
	for (const [name, rawRules] of Object.entries(contract)) {
		const rules = object(rawRules); const value = text(inputs[name]);
		if (rules.required === true && !value) return { error: `Workflow input ${name} is required.`, inputs: {} };
		if (!value) continue;
		if (Number.isInteger(rules.maximumLength) && value.length > Number(rules.maximumLength)) return { error: `Workflow input ${name} exceeds its maximum length.`, inputs: {} };
		if (text(rules.pattern)) {
			try { if (!new RegExp(text(rules.pattern), 'u').test(value)) return { error: `Workflow input ${name} is invalid.`, inputs: {} }; }
			catch { return { error: `Workflow input contract ${name} has an invalid pattern.`, inputs: {} }; }
		}
		normalized[name] = value;
	}
	return { error: null, inputs: normalized };
}

export async function queueRun(context: { store: any }, input: { definition: any; actorType: string; actorId: string; mode: string;
	ref: string; sourceSha: string; inputs: unknown; idempotencyKey: string; assignmentId?: string | null; handleId?: string | null }) {
	const { store } = context;
	if (!input.idempotencyKey || input.idempotencyKey.length > 240) throw Object.assign(new Error('A bounded idempotency key is required.'), { code: 'workflow_idempotency_key_required', status: 422 });
	const validation = validateInputs(input.definition, input.inputs);
	if (validation.error) throw Object.assign(new Error(validation.error), { code: 'workflow_inputs_invalid', status: 422 });
	if (!array(input.definition.modePolicy).includes(input.mode)) throw Object.assign(new Error('The workflow operation does not allow this execution mode.'), { code: 'workflow_mode_denied', status: 403 });
	if (!array(input.definition.refPolicy).includes(input.ref)) throw Object.assign(new Error('The requested ref is outside the workflow operation policy.'), { code: 'workflow_ref_denied', status: 403 });
	if (!/^[0-9a-f]{40}$/u.test(input.sourceSha)) throw Object.assign(new Error('An exact 40-character source SHA is required.'), { code: 'workflow_source_sha_required', status: 422 });
	const existing = await store.first(`SELECT r.* FROM workflow_operation_runs r JOIN platform_operations p ON p.id = r.correlation_id
		WHERE p.namespace = 'workflow' AND p.operation = 'dispatch' AND p.idempotency_key = ? LIMIT 1`, [input.idempotencyKey]);
	if (existing) return { run: serializeWorkflowOperationRun(existing), operation: await store.findPlatformOperationById(existing.correlation_id) };
	const runId = randomUUID(); const correlationId = randomUUID(); const now = new Date().toISOString();
	await store.run(`INSERT INTO workflow_operation_runs (id, operation_id, project_id, team_id, actor_type, actor_id, mode,
		assignment_id, handle_id, provider_id, provider_run_id, provider_run_url, source_sha, ref, correlation_id, status,
		artifacts_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'github-actions', NULL, NULL, ?, ?, ?, 'authorizing', '[]', ?, ?)`,
		[runId, input.definition.id, input.definition.projectId, input.definition.teamId, input.actorType, input.actorId,
			input.mode, input.assignmentId ?? null, input.handleId ?? null, input.sourceSha, input.ref, correlationId, now, now]);
	try {
		const operation = await store.createPlatformOperation({ id: correlationId, namespace: 'workflow', operation: 'dispatch',
			target: 'control_plane_operations_runner', idempotencyKey: input.idempotencyKey, requestedByType: input.actorType,
			requestedById: input.actorId, input: { runId, inputs: validation.inputs, actorType: input.actorType,
				actorId: input.actorId, mode: input.mode, assignmentId: input.assignmentId ?? null, handleId: input.handleId ?? null } });
		await store.recordAuditEvent({ eventType: 'workflow.dispatch.queued', actorType: input.actorType, actorId: input.actorId,
			targetType: 'workflow_operation_run', targetId: runId, data: { operationId: input.definition.id,
				projectId: input.definition.projectId, teamId: input.definition.teamId, sourceSha: input.sourceSha, ref: input.ref,
				correlationId, assignmentId: input.assignmentId ?? null } });
		return { run: serializeWorkflowOperationRun(await store.first('SELECT * FROM workflow_operation_runs WHERE id = ?', [runId])), operation };
	} catch (error) {
		await store.run('UPDATE workflow_operation_runs SET status = \'failed\', updated_at = ? WHERE id = ?', [new Date().toISOString(), runId]);
		throw error;
	}
}

function isAdministrator(principal: NonNullable<Principal>) {
	return principal.roles?.some((role) => role === 'admin' || role === 'platform_admin') || principal.permissions?.includes('*:*:*') || false;
}

async function access(store: any, principal: Principal, projectId: string, permission: string) {
	if (!principal) throw new WorkflowOperationError(401, 'authentication_required', 'Authentication is required.');
	const details = await store.getProjectDetails(projectId);
	if (!details?.project) throw new WorkflowOperationError(404, 'project_not_found', 'The project was not found.');
	const administrator = isAdministrator(principal);
	if (!administrator && !await store.principalCanAccessTeam(principal, details.project.teamId)) throw new WorkflowOperationError(403, 'workflow_access_denied', 'The principal cannot access this workflow.');
	const summary = administrator ? { permissions: ['*:*:*'] } : await store.getTeamAccessSummary(details.project.teamId, principal);
	if (!administrator && !summary.permissions.includes(permission)) throw new WorkflowOperationError(403, 'workflow_permission_denied', `${permission} authority is required.`);
	return { principal, project: details.project };
}

function failure(error: unknown, fallbackStatus: 400 | 503, fallbackCode: string): never {
	if (error instanceof WorkflowOperationError) throw error;
	const value = error as { status?: number; code?: string; message?: string };
	const status = [400, 401, 403, 404, 409, 412, 422, 503].includes(Number(value.status)) ? Number(value.status) : fallbackStatus;
	throw new WorkflowOperationError(status as WorkflowOperationError['status'], value.code ?? fallbackCode, value.message ?? fallbackCode);
}

export function createWorkflowService(store: any) {
	return {
		async operations(principal: Principal, projectId: string, query: Record<string, unknown>) {
			await access(store, principal, projectId, 'projects:read:team');
			const pageLimit = limit(query.limit, 100); const cursor = text(query.cursor);
			const rows = cursor
				? await store.all('SELECT * FROM project_workflow_operations WHERE project_id = ? AND id > ? ORDER BY id ASC LIMIT ?', [projectId, cursor, pageLimit + 1])
				: await store.all('SELECT * FROM project_workflow_operations WHERE project_id = ? ORDER BY id ASC LIMIT ?', [projectId, pageLimit + 1]);
			return { items: rows.slice(0, pageLimit).map(serializeWorkflowOperation), cursor: rows.length > pageLimit ? rows[pageLimit - 1].id : null };
		},
		async runs(principal: Principal, projectId: string, query: Record<string, unknown>) {
			await access(store, principal, projectId, 'projects:read:team');
			const pageLimit = limit(query.limit, 25); const operationId = text(query.operationId); const cursor = decodeRunCursor(query.cursor);
			const cursorClause = cursor ? ' AND (created_at < ? OR (created_at = ? AND id < ?))' : '';
			const cursorArguments = cursor ? [cursor.createdAt, cursor.createdAt, cursor.id] : [];
			const rows = operationId
				? await store.all(`SELECT * FROM workflow_operation_runs WHERE project_id = ? AND operation_id = ?${cursorClause} ORDER BY created_at DESC, id DESC LIMIT ?`, [projectId, operationId, ...cursorArguments, pageLimit + 1])
				: await store.all(`SELECT * FROM workflow_operation_runs WHERE project_id = ?${cursorClause} ORDER BY created_at DESC, id DESC LIMIT ?`, [projectId, ...cursorArguments, pageLimit + 1]);
			return { items: rows.slice(0, pageLimit).map(serializeWorkflowOperationRun), cursor: rows.length > pageLimit ? encodeRunCursor(rows[pageLimit - 1]) : null };
		},
		async update(principal: Principal, projectId: string, operationId: string, body: Record<string, unknown>, ifMatch?: string) {
			const granted = await access(store, principal, projectId, 'projects:manage:team');
			const repository = await store.first('SELECT * FROM project_remote_repository_bindings WHERE id = ? AND project_id = ? AND team_id = ?', [text(body.repositoryBindingId), projectId, granted.project.teamId]);
			const binding = await store.first(`SELECT * FROM team_service_capability_bindings WHERE id = ? AND team_id = ?
				AND capability_type = 'workflow-execution' AND status = 'configured'`, [text(body.workflowBindingId), granted.project.teamId]);
			if (!repository || !binding || repository.service_connection_id !== binding.connection_id) throw new WorkflowOperationError(409, 'workflow_binding_mismatch', 'Choose compatible repository and workflow bindings from the same provider connection.');
			const workflowId = text(body.workflowId);
			if (!/^\.github\/workflows\/[A-Za-z0-9._/-]+\.ya?ml$/u.test(workflowId) || workflowId.includes('..')) throw new WorkflowOperationError(422, 'workflow_id_invalid', 'Choose a workflow YAML file under .github/workflows.');
			const refs = [...new Set(array(body.refPolicy).map(text).filter((ref) => /^refs\/(heads|tags)\/[A-Za-z0-9._/-]+$/u.test(ref) && !ref.includes('..')))];
			if (!refs.length || refs.length !== array(body.refPolicy).length) throw new WorkflowOperationError(422, 'workflow_refs_invalid', 'Declare at least one safe exact workflow ref.');
			const actors = [...new Set(array(body.actorPolicy).map(text).filter((value) => ['user', 'operator', 'capacity_provider'].includes(value)))];
			const modes = [...new Set(array(body.modePolicy).map(text).filter((value) => ['planning', 'acting', 'operator'].includes(value)))];
			if (!actors.length || !modes.length) throw new WorkflowOperationError(422, 'workflow_policy_invalid', 'Declare permitted actors and execution modes.');
			const allowedInputs = object(body.allowedInputs); delete allowedInputs.treeseed_operation_correlation;
			for (const [name, rules] of Object.entries(allowedInputs)) {
				if (!/^[A-Za-z_][A-Za-z0-9_-]{0,99}$/u.test(name) || typeof rules !== 'object' || Array.isArray(rules)) throw new WorkflowOperationError(422, 'workflow_inputs_invalid', 'Workflow input contracts are invalid.');
				try { if (text(object(rules).pattern)) new RegExp(text(object(rules).pattern), 'u'); } catch { throw new WorkflowOperationError(422, 'workflow_inputs_invalid', `Workflow input ${name} has an invalid pattern.`); }
			}
			const requirements = (value: unknown) => array(value).map(object).map((item) => ({ name: text(item.name), scope: text(item.scope), environment: text(item.environment) || null, required: item.required !== false })).filter((item) => /^[A-Z_][A-Z0-9_]{0,99}$/u.test(item.name) && ['repository', 'environment', 'organization'].includes(item.scope) && (item.scope !== 'environment' || item.environment));
			const secrets = requirements(body.requiredSecrets); const variables = requirements(body.requiredVariables);
			if (secrets.length !== array(body.requiredSecrets).length || variables.length !== array(body.requiredVariables).length) throw new WorkflowOperationError(422, 'workflow_requirements_invalid', 'Secret or variable requirements are invalid.');
			const existing = await store.first('SELECT * FROM project_workflow_operations WHERE id = ? AND project_id = ?', [operationId, projectId]);
			const version = Number(ifMatch); if (!Number.isSafeInteger(version) || version < 0 || version !== Number(existing?.version ?? 0)) throw new WorkflowOperationError(412, 'workflow_operation_precondition_failed', 'The workflow operation changed after it was inspected.');
			const now = new Date().toISOString();
			await store.run(`INSERT INTO project_workflow_operations (id, project_id, team_id, workflow_binding_id, repository_binding_id,
				workflow_id, ref_policy_json, allowed_inputs_json, required_secrets_json, required_variables_json, actor_policy_json,
				mode_policy_json, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
				ON CONFLICT(id) DO UPDATE SET workflow_binding_id = excluded.workflow_binding_id, repository_binding_id = excluded.repository_binding_id,
				workflow_id = excluded.workflow_id, ref_policy_json = excluded.ref_policy_json, allowed_inputs_json = excluded.allowed_inputs_json,
				required_secrets_json = excluded.required_secrets_json, required_variables_json = excluded.required_variables_json,
				actor_policy_json = excluded.actor_policy_json, mode_policy_json = excluded.mode_policy_json,
				version = project_workflow_operations.version + 1, updated_at = excluded.updated_at`,
				[operationId, projectId, granted.project.teamId, binding.id, repository.id, workflowId, JSON.stringify(refs),
					JSON.stringify({ ...allowedInputs, treeseed_operation_correlation: { required: false, maximumLength: 64 } }),
					JSON.stringify(secrets), JSON.stringify(variables), JSON.stringify(actors), JSON.stringify(modes), now, now]);
			const saved = serializeWorkflowOperation(await store.first('SELECT * FROM project_workflow_operations WHERE id = ?', [operationId]));
			await store.recordAuditEvent({ eventType: 'workflow.operation.configured', actorType: 'user', actorId: granted.principal.id,
				targetType: 'project_workflow_operation', targetId: saved.id, data: { projectId, teamId: granted.project.teamId,
					workflowId, repositoryBindingId: repository.id, workflowBindingId: binding.id } });
			return saved;
		},
		async dispatch(principal: Principal, projectId: string, operationId: string, body: Record<string, unknown>, idempotencyKey?: string) {
			const granted = await access(store, principal, projectId, 'operations:authorize');
			const definition = serializeWorkflowOperation(await store.first('SELECT * FROM project_workflow_operations WHERE id = ? AND project_id = ?', [operationId, projectId]));
			if (!definition) throw new WorkflowOperationError(404, 'workflow_operation_not_found', 'Workflow operation not found.');
			if (!array(definition.actorPolicy).some((entry) => entry === 'user' || entry === 'operator')) throw new WorkflowOperationError(403, 'workflow_actor_denied', 'This workflow operation cannot be dispatched by a user.');
			try { return await queueRun({ store }, { definition, actorType: 'user', actorId: granted.principal.id, mode: 'operator',
				ref: text(body.ref), sourceSha: text(body.sourceSha), inputs: body.inputs, idempotencyKey: text(idempotencyKey) }); }
			catch (error) { failure(error, 400, 'workflow_dispatch_invalid'); }
		},
		async run(principal: Principal, runId: string) {
			const row = await store.first('SELECT * FROM workflow_operation_runs WHERE id = ?', [runId]);
			if (!row) throw new WorkflowOperationError(404, 'workflow_run_not_found', 'Workflow operation run not found.');
			await access(store, principal, row.project_id, 'projects:read:team');
			try { return serializeWorkflowOperationRun(await observeWorkflowRun(store, row)); }
			catch (error) { failure(error, 503, 'workflow_provider_unavailable'); }
		},
		async cancel(principal: Principal, runId: string) {
			let row = await store.first('SELECT * FROM workflow_operation_runs WHERE id = ?', [runId]);
			if (!row) throw new WorkflowOperationError(404, 'workflow_run_not_found', 'Workflow operation run not found.');
			const granted = await access(store, principal, row.project_id, 'operations:authorize');
			try {
				row = await observeWorkflowRun(store, row);
				if (row.status === 'cancelled' || row.status === 'cancelling') return serializeWorkflowOperationRun(row);
				if (!row.provider_run_id || !['queued', 'running'].includes(row.status)) throw new WorkflowOperationError(409, 'workflow_run_not_active', 'Only an active provider run can be cancelled.');
				const provider = await resolveWorkflowRunAuthority({ store, run: row });
				await githubActionsRequest(fetch, provider.credential.token, `${repositoryPath(provider.repository.owner, provider.repository.name)}/actions/runs/${encodeURIComponent(row.provider_run_id)}/cancel`, { method: 'POST' });
				const now = new Date().toISOString(); await store.run('UPDATE workflow_operation_runs SET status = \'cancelling\', updated_at = ? WHERE id = ?', [now, row.id]);
				await store.recordAuditEvent({ eventType: 'workflow.cancellation.requested', actorType: 'user', actorId: granted.principal.id,
					targetType: 'workflow_operation_run', targetId: row.id, data: { projectId: row.project_id, teamId: row.team_id,
						providerRunId: row.provider_run_id, correlationId: row.correlation_id } });
				return serializeWorkflowOperationRun({ ...row, status: 'cancelling', updated_at: now });
			} catch (error) { failure(error, 503, 'workflow_provider_unavailable'); }
		},
		async artifacts(principal: Principal, runId: string) {
			const row = await store.first('SELECT * FROM workflow_operation_runs WHERE id = ?', [runId]);
			if (!row) throw new WorkflowOperationError(404, 'workflow_run_not_found', 'Workflow operation run not found.');
			await access(store, principal, row.project_id, 'projects:read:team');
			if (!row.provider_run_id) return { items: [], cursor: null };
			try {
				const provider = await resolveWorkflowRunAuthority({ store, run: row });
				const live: any = await githubActionsRequest(fetch, provider.credential.token, `${repositoryPath(provider.repository.owner, provider.repository.name)}/actions/runs/${encodeURIComponent(row.provider_run_id)}/artifacts?per_page=100`);
				const items = (live.artifacts ?? []).slice(0, 100).map((item: any) => ({ id: String(item.id), name: String(item.name),
					sizeBytes: Number(item.size_in_bytes ?? 0), expired: Boolean(item.expired), digest: item.digest ?? null,
					createdAt: item.created_at, expiresAt: item.expires_at }));
				await store.run('UPDATE workflow_operation_runs SET artifacts_json = ?, updated_at = ? WHERE id = ?', [JSON.stringify(items), new Date().toISOString(), row.id]);
				return { items, cursor: null };
			} catch (error) { failure(error, 503, 'workflow_provider_unavailable'); }
		},
	};
}
