import { randomUUID } from 'node:crypto';
import { githubActionsRequest, reconciledWorkflowRunStatus, repositoryPath } from '../../../../providers/github/actions-client.ts';
import { fetchWorkflowArtifactArchive, WorkflowArtifactError } from '../../../../providers/github/workflow-artifacts.ts';
import { resolveWorkflowRunAuthority } from '../../../../providers/github/workflow-authority.ts';

const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';
const object = (value: unknown) => value && typeof value === 'object' && !Array.isArray(value)
	? value as Record<string, unknown> : {};
const array = (value: unknown) => Array.isArray(value) ? value : [];

function parse(value: unknown, fallback: unknown) {
	try { return JSON.parse(String(value ?? JSON.stringify(fallback))); } catch { return fallback; }
}

function serialize(row: any) {
	if (!row) return null;
	return {
		id: row.id, projectId: row.project_id, teamId: row.team_id,
		workflowBindingId: row.workflow_binding_id, repositoryBindingId: row.repository_binding_id,
		workflowId: row.workflow_id, refPolicy: parse(row.ref_policy_json, []),
		allowedInputs: parse(row.allowed_inputs_json, {}), requiredSecrets: parse(row.required_secrets_json, []),
		requiredVariables: parse(row.required_variables_json, []), actorPolicy: parse(row.actor_policy_json, []),
		modePolicy: parse(row.mode_policy_json, []), version: Number(row.version),
		createdAt: row.created_at, updatedAt: row.updated_at,
	};
}

function serializeRun(row: any) {
	if (!row) return null;
	return {
		id: row.id, operationId: row.operation_id, projectId: row.project_id, teamId: row.team_id,
		actorType: row.actor_type, actorId: row.actor_id, mode: row.mode,
		assignmentId: row.assignment_id, handleId: row.handle_id,
		providerId: row.provider_id, providerRunId: row.provider_run_id, providerRunUrl: row.provider_run_url,
		sourceSha: row.source_sha, ref: row.ref, correlationId: row.correlation_id, status: row.status,
		artifacts: parse(row.artifacts_json, []), createdAt: row.created_at, updatedAt: row.updated_at,
	};
}

export async function observeWorkflowRun(store: any, row: any, fetchImpl: typeof fetch = fetch) {
	if (!row?.provider_run_id) return row;
	const provider = await resolveWorkflowRunAuthority({ store, run: row, fetchImpl });
	const live: any = await githubActionsRequest(fetchImpl, provider.credential.token,
		`${repositoryPath(provider.repository.owner, provider.repository.name)}/actions/runs/${encodeURIComponent(row.provider_run_id)}`);
	const status = reconciledWorkflowRunStatus(String(row.status ?? ''), String(live.status ?? ''), live.conclusion ?? null);
	await store.run(`UPDATE workflow_operation_runs SET provider_run_url = ?, status = ?, updated_at = ? WHERE id = ?`,
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
		const rules = object(rawRules);
		const value = text(inputs[name]);
		if (rules.required === true && !value) return { error: `Workflow input ${name} is required.`, inputs: {} };
		if (!value) continue;
		if (Number.isInteger(rules.maximumLength) && value.length > Number(rules.maximumLength)) {
			return { error: `Workflow input ${name} exceeds its maximum length.`, inputs: {} };
		}
		if (text(rules.pattern)) {
			try { if (!new RegExp(text(rules.pattern), 'u').test(value)) return { error: `Workflow input ${name} is invalid.`, inputs: {} }; }
			catch { return { error: `Workflow input contract ${name} has an invalid pattern.`, inputs: {} }; }
		}
		normalized[name] = value;
	}
	return { error: null, inputs: normalized };
}

async function queueRun(context: any, input: {
	definition: any; actorType: string; actorId: string; mode: string; ref: string; sourceSha: string;
	inputs: unknown; idempotencyKey: string; assignmentId?: string | null; handleId?: string | null;
}) {
	const { store } = context;
	if (!input.idempotencyKey || input.idempotencyKey.length > 240) throw Object.assign(new Error('A bounded idempotency key is required.'), { code: 'workflow_idempotency_key_required', status: 422 });
	const validation = validateInputs(input.definition, input.inputs);
	if (validation.error) throw Object.assign(new Error(validation.error), { code: 'workflow_inputs_invalid', status: 422 });
	if (!array(input.definition.modePolicy).includes(input.mode)) throw Object.assign(new Error('The workflow operation does not allow this execution mode.'), { code: 'workflow_mode_denied', status: 403 });
	if (!array(input.definition.refPolicy).includes(input.ref)) throw Object.assign(new Error('The requested ref is outside the workflow operation policy.'), { code: 'workflow_ref_denied', status: 403 });
	if (!/^[0-9a-f]{40}$/u.test(input.sourceSha)) throw Object.assign(new Error('An exact 40-character source SHA is required.'), { code: 'workflow_source_sha_required', status: 422 });
	const existing = await store.first(`SELECT r.* FROM workflow_operation_runs r
		JOIN platform_operations p ON p.id = r.correlation_id
		WHERE p.namespace = 'workflow' AND p.operation = 'dispatch' AND p.idempotency_key = ? LIMIT 1`, [input.idempotencyKey]);
	if (existing) return { run: serializeRun(existing), operation: await store.findPlatformOperationById(existing.correlation_id) };
	const runId = randomUUID();
	const correlationId = randomUUID();
	const now = new Date().toISOString();
	await store.run(`INSERT INTO workflow_operation_runs
		(id, operation_id, project_id, team_id, actor_type, actor_id, mode, assignment_id, handle_id,
		 provider_id, provider_run_id, provider_run_url, source_sha, ref,
		 correlation_id, status, artifacts_json, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'github-actions', NULL, NULL, ?, ?, ?, 'authorizing', '[]', ?, ?)`,
		[runId, input.definition.id, input.definition.projectId, input.definition.teamId, input.actorType, input.actorId,
			input.mode, input.assignmentId ?? null, input.handleId ?? null, input.sourceSha, input.ref, correlationId, now, now]);
	try {
		const operation = await store.createPlatformOperation({ id: correlationId, namespace: 'workflow', operation: 'dispatch',
			target: 'control_plane_operations_runner', idempotencyKey: input.idempotencyKey, requestedByType: input.actorType,
			requestedById: input.actorId, input: { runId, inputs: validation.inputs, actorType: input.actorType,
				actorId: input.actorId, mode: input.mode, assignmentId: input.assignmentId ?? null, handleId: input.handleId ?? null } });
		await store.recordAuditEvent({ eventType: 'workflow.dispatch.queued', actorType: input.actorType, actorId: input.actorId,
			targetType: 'workflow_operation_run', targetId: runId, data: { operationId: input.definition.id,
				projectId: input.definition.projectId, teamId: input.definition.teamId, sourceSha: input.sourceSha,
				ref: input.ref, correlationId, assignmentId: input.assignmentId ?? null } });
		return { run: serializeRun(await store.first('SELECT * FROM workflow_operation_runs WHERE id = ?', [runId])), operation };
	} catch (error) {
		await store.run(`UPDATE workflow_operation_runs SET status = 'failed', updated_at = ? WHERE id = ?`, [new Date().toISOString(), runId]);
		throw error;
	}
}

export function installProjectWorkflowOperationRoutes(context: any) {
	const { app, jsonError, requireProjectAccess, store } = context;
	app.get('/v1/projects/:projectId/workflow-operations', async (c: any) => {
		const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:read:team');
		if (access.response) return access.response;
		const rows = await store.all('SELECT * FROM project_workflow_operations WHERE project_id = ? ORDER BY id ASC', [c.req.param('projectId')]);
		return c.json({ ok: true, payload: rows.map(serialize) });
	});
	app.get('/v1/projects/:projectId/workflow-operation-runs', async (c: any) => {
		const projectId = c.req.param('projectId');
		const access = await requireProjectAccess(c, store, projectId, 'projects:read:team');
		if (access.response) return access.response;
		const rawLimit = text(c.req.query('limit')) || '25';
		const limit = Number(rawLimit);
		if (!/^\d+$/u.test(rawLimit) || !Number.isInteger(limit) || limit < 1 || limit > 100) {
			return jsonError(c, 400, 'Workflow run limit must be a whole number between 1 and 100.', { code: 'workflow_run_limit_invalid' });
		}
		const operationId = text(c.req.query('operationId'));
		const rows = operationId
			? await store.all(`SELECT * FROM workflow_operation_runs WHERE project_id = ? AND operation_id = ?
				ORDER BY created_at DESC, id DESC LIMIT ?`, [projectId, operationId, limit])
			: await store.all(`SELECT * FROM workflow_operation_runs WHERE project_id = ?
				ORDER BY created_at DESC, id DESC LIMIT ?`, [projectId, limit]);
		return c.json({ ok: true, payload: rows.map(serializeRun) }, 200, { 'Cache-Control': 'private, no-store' });
	});
	app.put('/v1/projects/:projectId/workflow-operations/:operationId', async (c: any) => {
		const projectId = c.req.param('projectId');
		const access = await requireProjectAccess(c, store, projectId, 'projects:manage:team');
		if (access.response) return access.response;
		const body = await c.req.json().catch(() => ({}));
		const project = access.details.project;
		const repository = await store.first('SELECT * FROM project_remote_repository_bindings WHERE id = ? AND project_id = ? AND team_id = ?', [text(body.repositoryBindingId), projectId, project.teamId]);
		const workflowBinding = await store.first(`SELECT * FROM team_service_capability_bindings WHERE id = ? AND team_id = ?
			AND capability_type = 'workflow-execution' AND status = 'configured'`, [text(body.workflowBindingId), project.teamId]);
		if (!repository || !workflowBinding || repository.service_connection_id !== workflowBinding.connection_id) {
			return jsonError(c, 409, 'Choose compatible repository and workflow bindings from the same provider connection.', { code: 'workflow_binding_mismatch' });
		}
		const workflowId = text(body.workflowId);
		if (!/^\.github\/workflows\/[A-Za-z0-9._/-]+\.ya?ml$/u.test(workflowId) || workflowId.includes('..')) {
			return jsonError(c, 422, 'Choose a workflow YAML file under .github/workflows.', { fieldErrors: { workflowId: 'Enter a safe workflow path.' } });
		}
		const refs = [...new Set(array(body.refPolicy).map(text).filter((ref) => /^refs\/(heads|tags)\/[A-Za-z0-9._/-]+$/u.test(ref) && !ref.includes('..')))];
		if (!refs.length || refs.length !== array(body.refPolicy).length) return jsonError(c, 422, 'Declare at least one safe exact workflow ref.', { fieldErrors: { refPolicy: 'Choose exact branch or tag refs.' } });
		const actors = [...new Set(array(body.actorPolicy).map(text).filter((value) => ['user', 'operator', 'capacity_provider'].includes(value)))];
		const modes = [...new Set(array(body.modePolicy).map(text).filter((value) => ['planning', 'acting', 'operator'].includes(value)))];
		if (!actors.length || !modes.length) return jsonError(c, 422, 'Declare the permitted actors and execution modes.');
		const allowedInputs = object(body.allowedInputs);
		delete allowedInputs.treeseed_operation_correlation;
		for (const [name, rules] of Object.entries(allowedInputs)) {
			if (!/^[A-Za-z_][A-Za-z0-9_-]{0,99}$/u.test(name) || typeof rules !== 'object' || Array.isArray(rules)) return jsonError(c, 422, 'Workflow input contracts are invalid.');
			try { if (text(object(rules).pattern)) new RegExp(text(object(rules).pattern), 'u'); } catch { return jsonError(c, 422, `Workflow input ${name} has an invalid pattern.`); }
		}
		const requirements = (value: unknown) => array(value).map(object).map((item) => ({ name: text(item.name), scope: text(item.scope),
			environment: text(item.environment) || null, required: item.required !== false })).filter((item) => /^[A-Z_][A-Z0-9_]{0,99}$/u.test(item.name)
			&& ['repository', 'environment', 'organization'].includes(item.scope) && (item.scope !== 'environment' || item.environment));
		const secrets = requirements(body.requiredSecrets); const variables = requirements(body.requiredVariables);
		if (secrets.length !== array(body.requiredSecrets).length || variables.length !== array(body.requiredVariables).length) return jsonError(c, 422, 'Secret or variable requirements are invalid.');
		const existing = await store.first('SELECT * FROM project_workflow_operations WHERE id = ? AND project_id = ?', [c.req.param('operationId'), projectId]);
		if (existing && Number(body.version) !== Number(existing.version)) return jsonError(c, 409, 'The workflow operation changed after this page loaded.', { code: 'workflow_operation_conflict' });
		const now = new Date().toISOString();
		await store.run(`INSERT INTO project_workflow_operations (id, project_id, team_id, workflow_binding_id, repository_binding_id,
			workflow_id, ref_policy_json, allowed_inputs_json, required_secrets_json, required_variables_json, actor_policy_json,
			mode_policy_json, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
			ON CONFLICT(id) DO UPDATE SET workflow_binding_id = excluded.workflow_binding_id, repository_binding_id = excluded.repository_binding_id,
			workflow_id = excluded.workflow_id, ref_policy_json = excluded.ref_policy_json, allowed_inputs_json = excluded.allowed_inputs_json,
			required_secrets_json = excluded.required_secrets_json, required_variables_json = excluded.required_variables_json,
			actor_policy_json = excluded.actor_policy_json, mode_policy_json = excluded.mode_policy_json,
			version = project_workflow_operations.version + 1, updated_at = excluded.updated_at`,
			[c.req.param('operationId'), projectId, project.teamId, workflowBinding.id, repository.id, workflowId, JSON.stringify(refs),
				JSON.stringify({ ...allowedInputs, treeseed_operation_correlation: { required: false, maximumLength: 64 } }), JSON.stringify(secrets), JSON.stringify(variables),
				JSON.stringify(actors), JSON.stringify(modes), now, now]);
		const saved = serialize(await store.first('SELECT * FROM project_workflow_operations WHERE id = ?', [c.req.param('operationId')]));
		await store.recordAuditEvent({ eventType: 'workflow.operation.configured', actorType: 'user', actorId: access.principal.id,
			targetType: 'project_workflow_operation', targetId: saved.id, data: { projectId, teamId: project.teamId, workflowId, repositoryBindingId: repository.id, workflowBindingId: workflowBinding.id } });
		return c.json({ ok: true, payload: saved });
	});
	app.post('/v1/projects/:projectId/workflow-operations/:operationId/dispatch', async (c: any) => {
		const projectId = c.req.param('projectId');
		const access = await requireProjectAccess(c, store, projectId, 'operations:authorize');
		if (access.response) return access.response;
		const definition = serialize(await store.first('SELECT * FROM project_workflow_operations WHERE id = ? AND project_id = ?', [c.req.param('operationId'), projectId]));
		if (!definition) return jsonError(c, 404, 'Workflow operation not found.');
		const body = await c.req.json().catch(() => ({}));
		const actorPolicy = array(definition.actorPolicy);
		if (!actorPolicy.includes('user') && !actorPolicy.includes('operator')) return jsonError(c, 403, 'This workflow operation cannot be dispatched by a user.', { code: 'workflow_actor_denied' });
		try {
			const result = await queueRun(context, { definition, actorType: 'user', actorId: access.principal.id,
				mode: 'operator', ref: text(body.ref), sourceSha: text(body.sourceSha), inputs: body.inputs,
				idempotencyKey: text(c.req.header('idempotency-key')) || text(body.idempotencyKey) });
			return c.json({ ok: true, payload: result }, 202);
		} catch (error: any) { return jsonError(c, error.status ?? 400, error.message, { code: error.code ?? 'workflow_dispatch_invalid' }); }
	});
	app.get('/v1/workflow-operation-runs/:runId', async (c: any) => {
		const row = await store.first('SELECT * FROM workflow_operation_runs WHERE id = ?', [c.req.param('runId')]);
		if (!row) return jsonError(c, 404, 'Workflow operation run not found.');
		const access = await requireProjectAccess(c, store, row.project_id, 'projects:read:team');
		if (access.response) return access.response;
		let observed = row;
		try { observed = await observeWorkflowRun(store, row); }
		catch (error) { return jsonError(c, 503, error instanceof Error ? error.message : String(error), { code: 'workflow_provider_unavailable' }); }
		return c.json({ ok: true, payload: serializeRun(observed) }, 200, { 'Cache-Control': 'private, no-store' });
	});
	app.post('/v1/workflow-operation-runs/:runId/cancel', async (c: any) => {
		let row = await store.first('SELECT * FROM workflow_operation_runs WHERE id = ?', [c.req.param('runId')]);
		if (!row) return jsonError(c, 404, 'Workflow operation run not found.');
		const access = await requireProjectAccess(c, store, row.project_id, 'operations:authorize');
		if (access.response) return access.response;
		try {
			row = await observeWorkflowRun(store, row);
			if (row.status === 'cancelled') return c.json({ ok: true, code: 'workflow_already_cancelled', payload: serializeRun(row) }, 200);
			if (row.status === 'cancelling') return c.json({ ok: true, code: 'workflow_cancellation_requested', payload: serializeRun(row) }, 202);
			if (!row.provider_run_id || !['queued', 'running'].includes(row.status)) return jsonError(c, 409, 'Only an active provider run can be cancelled.');
			const provider = await resolveWorkflowRunAuthority({ store, run: row });
			await githubActionsRequest(fetch, provider.credential.token,
				`${repositoryPath(provider.repository.owner, provider.repository.name)}/actions/runs/${encodeURIComponent(row.provider_run_id)}/cancel`, { method: 'POST' });
			const now = new Date().toISOString();
			await store.run(`UPDATE workflow_operation_runs SET status = 'cancelling', updated_at = ? WHERE id = ?`, [now, row.id]);
			await store.recordAuditEvent({ eventType: 'workflow.cancellation.requested', actorType: 'user', actorId: access.principal.id,
				targetType: 'workflow_operation_run', targetId: row.id, data: { projectId: row.project_id, teamId: row.team_id,
					providerRunId: row.provider_run_id, correlationId: row.correlation_id } });
			return c.json({ ok: true, code: 'workflow_cancellation_requested', payload: serializeRun({ ...row, status: 'cancelling', updated_at: now }) }, 202);
		} catch (error) { return jsonError(c, 503, error instanceof Error ? error.message : String(error), { code: 'workflow_provider_unavailable' }); }
	});
	app.get('/v1/workflow-operation-runs/:runId/artifacts', async (c: any) => {
		const row = await store.first('SELECT * FROM workflow_operation_runs WHERE id = ?', [c.req.param('runId')]);
		if (!row) return jsonError(c, 404, 'Workflow operation run not found.');
		const access = await requireProjectAccess(c, store, row.project_id, 'projects:read:team');
		if (access.response) return access.response;
		if (!row.provider_run_id) return c.json({ ok: true, payload: [] }, 200, { 'Cache-Control': 'private, no-store' });
		try {
			const provider = await resolveWorkflowRunAuthority({ store, run: row });
			const live: any = await githubActionsRequest(fetch, provider.credential.token,
				`${repositoryPath(provider.repository.owner, provider.repository.name)}/actions/runs/${encodeURIComponent(row.provider_run_id)}/artifacts?per_page=100`);
			const artifacts = (live.artifacts ?? []).slice(0, 100).map((item: any) => ({ id: String(item.id), name: String(item.name),
				sizeBytes: Number(item.size_in_bytes ?? 0), expired: Boolean(item.expired), digest: item.digest ?? null,
				createdAt: item.created_at, expiresAt: item.expires_at }));
			await store.run(`UPDATE workflow_operation_runs SET artifacts_json = ?, updated_at = ? WHERE id = ?`,
				[JSON.stringify(artifacts), new Date().toISOString(), row.id]);
			return c.json({ ok: true, payload: artifacts }, 200, { 'Cache-Control': 'private, no-store' });
		} catch (error) { return jsonError(c, 503, error instanceof Error ? error.message : String(error), { code: 'workflow_provider_unavailable' }); }
	});
	app.get('/v1/workflow-operation-runs/:runId/artifacts/:artifactId/download', async (c: any) => {
		const row = await store.first('SELECT * FROM workflow_operation_runs WHERE id = ?', [c.req.param('runId')]);
		if (!row) return jsonError(c, 404, 'Workflow operation run not found.');
		const access = await requireProjectAccess(c, store, row.project_id, 'projects:read:team');
		if (access.response) return access.response;
		if (!row.provider_run_id) return jsonError(c, 409, 'The provider workflow run has not started.', { code: 'workflow_run_not_started' });
		try {
			const provider = await resolveWorkflowRunAuthority({ store, run: row });
			const archive = await fetchWorkflowArtifactArchive({ fetchImpl: fetch, token: provider.credential.token,
				owner: provider.repository.owner, repository: provider.repository.name,
				runId: row.provider_run_id, artifactId: c.req.param('artifactId') });
			return new Response(archive.bytes, { headers: { 'Content-Type': 'application/zip', 'Cache-Control': 'private, no-store',
				'Content-Disposition': `attachment; filename="${archive.fileName}"`, 'X-Content-Type-Options': 'nosniff' } });
		} catch (error) {
			if (error instanceof WorkflowArtifactError) return jsonError(c, error.status, error.message, { code: error.code });
			return jsonError(c, 503, error instanceof Error ? error.message : String(error), { code: 'workflow_provider_unavailable' });
		}
	});
}

export { queueRun, serialize as serializeWorkflowOperation, serializeRun as serializeWorkflowOperationRun };
