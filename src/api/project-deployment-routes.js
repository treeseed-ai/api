import { randomUUID } from 'node:crypto';
import {
	deploymentKindForAction,
	forbiddenDeploymentFields,
	isProjectDeploymentEnvironment,
	isProjectWebDeploymentAction,
	normalizeDeploymentSource,
} from '../market/deployment-actions.ts';
import { jsonDeploymentError } from '../market/deployment-errors.ts';
import { checkProjectDeploymentPermission } from '../market/deployment-governance.ts';
import {
	buildProjectDeploymentReadiness,
	selectProjectDeploymentRepository,
	selectProjectWebTarget,
} from '../market/deployment-readiness.ts';
import { buildProjectDeploymentState } from '../market/deployment-projection.ts';

function operationUrls(projectId, deploymentId, operationId) {
	return {
		pollUrl: `/v1/platform/operations/${encodeURIComponent(operationId)}`,
		eventsUrl: `/v1/projects/${encodeURIComponent(projectId)}/deployments/${encodeURIComponent(deploymentId)}/events`,
		stateUrl: `/v1/projects/${encodeURIComponent(projectId)}/deployment-state`,
	};
}

function repositoryPayload(repository) {
	if (!repository) return null;
	return {
		provider: repository.provider ?? 'github',
		owner: repository.owner ?? null,
		name: repository.name ?? null,
		branch: repository.currentBranch ?? repository.defaultBranch ?? 'staging',
		workflowFile: 'deploy-web.yml',
		repositoryId: repository.id ?? null,
		role: repository.role ?? null,
		metadata: repository.metadata ?? {},
	};
}

function activeStatus(status) {
	return ['queued', 'claimed', 'dispatching', 'running', 'monitoring'].includes(status);
}

async function readBody(c) {
	const contentType = c.req.header('content-type') ?? '';
	if (contentType.includes('application/json')) {
		return await c.req.json().catch(() => ({}));
	}
	return {};
}

async function teamWebHosts(store, teamId) {
	return store.listTeamWebHosts ? await store.listTeamWebHosts(teamId).catch(() => []) : [];
}

async function marketRunners(store) {
	return store.listMarketOperationRunners ? await store.listMarketOperationRunners({ limit: 10 }).catch(() => []) : [];
}

function deploymentEnvelope(deployment, operation) {
	const urls = operationUrls(deployment.projectId, deployment.id, operation.id);
	return {
		ok: true,
		deployment,
		operation,
		...urls,
	};
}

export function installProjectDeploymentRoutes(app, { store, requireProjectAccess }) {
	async function requireDeploymentPermission(c, projectId, intent, input = {}) {
		const access = await requireProjectAccess(c, store, projectId, null);
		if (access.response) return access;
		const permission = await checkProjectDeploymentPermission({
			store,
			principal: access.principal,
			details: access.details,
			intent,
			...input,
		});
		if (!permission.ok) {
			return {
				...access,
				response: jsonDeploymentError(c, 'not_authorized', permission.message, {
					status: 403,
					details: { permission: permission.permission },
				}),
			};
		}
		return access;
	}

	app.get('/v1/project-deployments/:deploymentId', async (c) => {
		const deployment = await store.findProjectDeploymentById(c.req.param('deploymentId'));
		if (!deployment) {
			return jsonDeploymentError(c, 'deployment_not_found', `Unknown deployment "${c.req.param('deploymentId')}".`);
		}
		const access = await requireDeploymentPermission(c, deployment.projectId, 'read');
		if (access.response) return access.response;
		const safeCall = (fn, ...args) => typeof fn === 'function' ? fn.apply(store, args).catch(() => null) : Promise.resolve(null);
		const [events, job, launch, project] = await Promise.all([
			store.listProjectDeploymentEvents(deployment.id, { limit: c.req.query('limit') }),
			deployment.platformOperationId ? safeCall(store.findJobById, deployment.platformOperationId) : null,
			deployment.platformOperationId ? safeCall(store.getHubLaunchByJobId, deployment.platformOperationId) : null,
			safeCall(store.getProjectSummary, deployment.projectId, access.principal),
		]);
		return c.json({
			ok: true,
			payload: {
				deployment,
				events,
				job,
				launch,
				project,
				projectDetails: access.details,
			},
		});
	});

	app.get('/v1/projects/:projectId/deployment-state', async (c) => {
		const access = await requireDeploymentPermission(c, c.req.param('projectId'), 'read');
		if (access.response) return access.response;
		const state = await buildProjectDeploymentState({ store, projectId: c.req.param('projectId'), details: access.details });
		if (!state) return jsonDeploymentError(c, 'project_not_found', `Unknown project "${c.req.param('projectId')}".`);
		return c.json(state);
	});

	app.get('/v1/projects/:projectId/deployments', async (c) => {
		const access = await requireDeploymentPermission(c, c.req.param('projectId'), 'read');
		if (access.response) return access.response;
		const filters = {
			environment: c.req.query('environment') || undefined,
			action: c.req.query('action') || undefined,
			status: c.req.query('status') || undefined,
			limit: c.req.query('limit') || undefined,
		};
		return c.json({
			ok: true,
			payload: await store.listProjectDeployments(c.req.param('projectId'), filters),
		});
	});

	app.post('/v1/projects/:projectId/deployments/web', async (c) => {
		const projectId = c.req.param('projectId');
		const access = await requireProjectAccess(c, store, projectId, null);
		if (access.response) return access.response;
		const body = await readBody(c);
		const forbidden = forbiddenDeploymentFields(body);
		if (forbidden.length > 0) {
			return jsonDeploymentError(c, 'validation_failed', 'Deployment requests must not include capacity-provider or runtime-processing fields.', {
				status: 400,
				details: { fields: forbidden },
			});
		}
		if (!isProjectDeploymentEnvironment(body.environment)) {
			return jsonDeploymentError(c, 'invalid_environment', 'environment must be staging or prod.', { status: 400 });
		}
		if (!isProjectWebDeploymentAction(body.action)) {
			return jsonDeploymentError(c, 'invalid_action', 'action must be deploy_web, publish_content, or monitor.', { status: 400 });
		}
		if (body.environment === 'prod' && body.action !== 'monitor' && body.confirmProduction !== true) {
			return jsonDeploymentError(c, 'deployment_not_ready', 'Production deploy and publish require explicit confirmation.');
		}
		const permission = await checkProjectDeploymentPermission({
			store,
			principal: access.principal,
			details: access.details,
			intent: 'create',
			environment: body.environment,
			action: body.action,
		});
		if (!permission.ok) {
			return jsonDeploymentError(c, 'not_authorized', permission.message, {
				status: 403,
				details: { permission: permission.permission },
			});
		}
		const idempotencyKey = typeof body.idempotencyKey === 'string' && body.idempotencyKey.trim()
			? body.idempotencyKey.trim()
			: c.req.header('idempotency-key') || `project:${projectId}:web:${body.environment}:${body.action}:manual:${randomUUID()}`;
		const existing = await store.findProjectDeploymentByIdempotencyKey(projectId, idempotencyKey);
		if (existing?.platformOperationId) {
			const operation = await store.findPlatformOperationById(existing.platformOperationId);
			return c.json(deploymentEnvelope(existing, operation));
		}
		const active = await store.listActiveProjectDeployments(projectId, body.environment, body.action);
		if (active.some((deployment) => deployment.idempotencyKey !== idempotencyKey)) {
			return jsonDeploymentError(c, 'operation_conflict', 'A deployment operation is already active for this project, environment, and action.');
		}
		const hosts = await teamWebHosts(store, access.details.project.teamId);
		const runners = await marketRunners(store);
		const readiness = buildProjectDeploymentReadiness({
			details: access.details,
			teamWebHosts: hosts,
			activeOperations: active,
			runners,
			environment: body.environment,
			action: body.action,
			confirmProduction: body.confirmProduction === true,
		});
		if (!readiness.ready) {
			const repositoryBlocker = readiness.blockers.find((blocker) => blocker.code === 'repository_configured');
			const hostBlocker = readiness.blockers.find((blocker) => blocker.code === 'web_host_configured');
			if (repositoryBlocker) return jsonDeploymentError(c, 'repository_not_ready', repositoryBlocker.message, { details: { blockers: readiness.blockers } });
			if (hostBlocker) return jsonDeploymentError(c, 'host_not_ready', hostBlocker.message, { details: { blockers: readiness.blockers } });
			return jsonDeploymentError(c, 'deployment_not_ready', 'Deployment is blocked by project readiness checks.', { details: { blockers: readiness.blockers } });
		}
		const repository = selectProjectDeploymentRepository(access.details, body.action);
		const target = selectProjectWebTarget(access.details, hosts);
		const deployment = await store.createProjectDeployment(projectId, {
			teamId: access.details.project.teamId,
			environment: body.environment,
			action: body.action,
			deploymentKind: deploymentKindForAction(body.action),
			status: 'queued',
			idempotencyKey,
			requestedByUserId: access.principal.id,
			triggeredByType: normalizeDeploymentSource(body.source),
			triggeredById: access.principal.id,
			sourceRef: typeof body.reason === 'string' ? body.reason : null,
			repository: repositoryPayload(repository),
			target,
			summary: `Queued ${body.action} for ${body.environment}.`,
			metadata: {
				source: normalizeDeploymentSource(body.source),
				reason: typeof body.reason === 'string' ? body.reason : null,
				previewId: typeof body.previewId === 'string' ? body.previewId : null,
				dryRun: body.dryRun === true,
			},
		});
		const operationInput = {
			namespace: 'project',
			operation: 'web_deployment',
			projectId,
			teamId: access.details.project.teamId,
			deploymentId: deployment.id,
			environment: body.environment,
			action: body.action,
			source: normalizeDeploymentSource(body.source),
			repositoryId: repository?.id ?? null,
			webHostId: target.hostId ?? null,
			workflowFile: 'deploy-web.yml',
			dispatchStrategy: 'runner_direct_github_dispatch',
			previewId: typeof body.previewId === 'string' ? body.previewId : null,
			dryRun: body.dryRun === true,
		};
		const operation = await store.createPlatformOperation({
			namespace: 'project',
			operation: 'web_deployment',
			target: 'market_operations_runner',
			idempotencyKey,
			input: operationInput,
			requestedByType: 'user',
			requestedById: access.principal.id,
		});
		const updated = await store.updateProjectDeployment(deployment.id, { platformOperationId: operation.id });
		await store.appendProjectDeploymentEvent(deployment.id, {
			kind: 'deployment.operation_queued',
			message: 'Market operation queued for deployment.',
			operationId: operation.id,
			status: 'queued',
		});
		await store.recordProjectDeploymentAudit?.(updated, 'project_deployment_requested', {
			actorType: 'user',
			actorId: access.principal.id,
			status: updated.status,
			operationId: operation.id,
		});
		if (updated.environment === 'prod' && updated.action !== 'monitor') {
			await store.recordProjectDeploymentAudit?.(updated, 'project_production_deployment_requested', {
				actorType: 'user',
				actorId: access.principal.id,
				status: updated.status,
				operationId: operation.id,
			});
		}
		if (updated.action === 'publish_content') {
			await store.recordProjectDeploymentAudit?.(updated, 'project_content_publish_requested', {
				actorType: 'user',
				actorId: access.principal.id,
				status: updated.status,
				operationId: operation.id,
			});
		}
		return c.json(deploymentEnvelope(updated, operation), { status: 202 });
	});

	app.get('/v1/projects/:projectId/deployments/:deploymentId', async (c) => {
		const access = await requireDeploymentPermission(c, c.req.param('projectId'), 'read');
		if (access.response) return access.response;
		const deployment = await store.findProjectDeploymentById(c.req.param('deploymentId'));
		if (!deployment || deployment.projectId !== c.req.param('projectId')) {
			return jsonDeploymentError(c, 'deployment_not_found', `Unknown deployment "${c.req.param('deploymentId')}".`);
		}
		return c.json({ ok: true, payload: deployment });
	});

	app.get('/v1/projects/:projectId/deployments/:deploymentId/events', async (c) => {
		const access = await requireDeploymentPermission(c, c.req.param('projectId'), 'read');
		if (access.response) return access.response;
		const deployment = await store.findProjectDeploymentById(c.req.param('deploymentId'));
		if (!deployment || deployment.projectId !== c.req.param('projectId')) {
			return jsonDeploymentError(c, 'deployment_not_found', `Unknown deployment "${c.req.param('deploymentId')}".`);
		}
		return c.json({
			ok: true,
			payload: await store.listProjectDeploymentEvents(deployment.id, { limit: c.req.query('limit') }),
		});
	});

	app.post('/v1/projects/:projectId/deployments/:deploymentId/retry', async (c) => {
		const access = await requireProjectAccess(c, store, c.req.param('projectId'), null);
		if (access.response) return access.response;
		const original = await store.findProjectDeploymentById(c.req.param('deploymentId'));
		if (!original || original.projectId !== c.req.param('projectId')) {
			return jsonDeploymentError(c, 'deployment_not_found', `Unknown deployment "${c.req.param('deploymentId')}".`);
		}
		const permission = await checkProjectDeploymentPermission({
			store,
			principal: access.principal,
			details: access.details,
			intent: 'retry',
			deployment: original,
		});
		if (!permission.ok) {
			return jsonDeploymentError(c, 'not_authorized', permission.message, {
				status: 403,
				details: { permission: permission.permission },
			});
		}
		if (!['failed', 'timed_out', 'cancelled'].includes(original.status)) {
			return jsonDeploymentError(c, 'operation_not_retryable', 'Only failed, timed out, or cancelled deployments can be retried.');
		}
		const body = await readBody(c);
		const idempotencyKey = typeof body.idempotencyKey === 'string' && body.idempotencyKey.trim()
			? body.idempotencyKey.trim()
			: `project:${original.projectId}:web:${original.environment}:${original.action}:retry:${original.id}:${randomUUID()}`;
		const retryDeployment = await store.createProjectDeploymentRetry(original.id, {
			status: 'queued',
			idempotencyKey,
			requestedByUserId: access.principal.id,
			triggeredByType: 'api',
			triggeredById: access.principal.id,
			summary: `Retry queued for ${original.action} ${original.environment}.`,
		});
		const operation = await store.createPlatformOperation({
			namespace: 'project',
			operation: 'web_deployment',
			target: 'market_operations_runner',
			idempotencyKey,
			input: {
				namespace: 'project',
				operation: 'web_deployment',
				projectId: original.projectId,
				teamId: original.teamId,
				deploymentId: retryDeployment.id,
				environment: retryDeployment.environment,
				action: retryDeployment.action,
				source: 'api',
				repositoryId: retryDeployment.repository?.repositoryId ?? null,
				webHostId: retryDeployment.target?.hostId ?? null,
				workflowFile: 'deploy-web.yml',
				dispatchStrategy: 'runner_direct_github_dispatch',
			},
			requestedByType: 'user',
			requestedById: access.principal.id,
		});
		const updatedRetry = await store.updateProjectDeployment(retryDeployment.id, { platformOperationId: operation.id });
		await store.recordProjectDeploymentAudit?.(updatedRetry, 'project_deployment_retry_requested', {
			actorType: 'user',
			actorId: access.principal.id,
			status: updatedRetry.status,
			operationId: operation.id,
		});
		return c.json({
			ok: true,
			originalDeployment: original,
			retryDeployment: updatedRetry,
			operation,
		}, { status: 202 });
	});

	app.post('/v1/projects/:projectId/deployments/:deploymentId/resume', async (c) => {
		const access = await requireProjectAccess(c, store, c.req.param('projectId'), null);
		if (access.response) return access.response;
		const deployment = await store.findProjectDeploymentById(c.req.param('deploymentId'));
		if (!deployment || deployment.projectId !== c.req.param('projectId')) {
			return jsonDeploymentError(c, 'deployment_not_found', `Unknown deployment "${c.req.param('deploymentId')}".`);
		}
		const permission = await checkProjectDeploymentPermission({
			store,
			principal: access.principal,
			details: access.details,
			intent: 'resume',
			deployment,
		});
		if (!permission.ok) {
			return jsonDeploymentError(c, 'not_authorized', permission.message, {
				status: 403,
				details: { permission: permission.permission },
			});
		}
		await store.recordProjectDeploymentAudit?.(deployment, 'project_deployment_resume_requested', {
			actorType: 'user',
			actorId: access.principal.id,
			status: deployment.status,
		});
		return jsonDeploymentError(c, 'operation_not_retryable', 'Deployment resume is not supported until runner checkpoints are implemented.');
	});

	app.post('/v1/projects/:projectId/deployments/:deploymentId/cancel', async (c) => {
		const access = await requireProjectAccess(c, store, c.req.param('projectId'), null);
		if (access.response) return access.response;
		const deployment = await store.findProjectDeploymentById(c.req.param('deploymentId'));
		if (!deployment || deployment.projectId !== c.req.param('projectId')) {
			return jsonDeploymentError(c, 'deployment_not_found', `Unknown deployment "${c.req.param('deploymentId')}".`);
		}
		const permission = await checkProjectDeploymentPermission({
			store,
			principal: access.principal,
			details: access.details,
			intent: 'cancel',
			deployment,
		});
		if (!permission.ok) {
			return jsonDeploymentError(c, 'not_authorized', permission.message, {
				status: 403,
				details: { permission: permission.permission },
			});
		}
		if (!activeStatus(deployment.status)) {
			return jsonDeploymentError(c, 'operation_not_cancellable', 'Only queued or running deployments can be cancelled.');
		}
		if (deployment.platformOperationId) {
			await store.cancelPlatformOperation(deployment.platformOperationId);
		}
		const updated = await store.markProjectDeploymentCancellationRequested(deployment.id, { id: access.principal.id, type: 'user' });
		await store.recordProjectDeploymentAudit?.(updated, 'project_deployment_cancel_requested', {
			actorType: 'user',
			actorId: access.principal.id,
			status: updated.status,
			operationId: updated.platformOperationId,
		});
		if (updated.status === 'cancelled') {
			await store.recordProjectDeploymentAudit?.(updated, 'project_deployment_cancelled', {
				actorType: 'user',
				actorId: access.principal.id,
				status: updated.status,
				operationId: updated.platformOperationId,
			});
		}
		return c.json({
			ok: true,
			deployment: updated,
			cancellation: updated.status === 'cancelled' ? 'completed' : 'requested',
		});
	});
}
