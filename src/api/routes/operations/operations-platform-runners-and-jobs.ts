export function installOperationsPlatformRunnersAndJobsRoutes(context: any) {
	const { app, config, decoratePlatformOperation, ensurePrincipal, isTeamApiPrincipal, jsonError, optionalTrimmedString, platformOperationMutationError, principalHasGlobalPlatformRole, principalHasPermission, requirePlatformRunner, runtime, store } = context;
	app.get('/v1/platform/operations', async (c) => {
					const auth = await ensurePrincipal(c);
					if (auth.response) return auth.response;
					if (!principalHasGlobalPlatformRole(auth.principal) && !principalHasPermission(auth.principal, 'platform:operations:read')) {
						return jsonError(c, 403, 'Permission denied.', { permission: 'platform:operations:read' });
					}
					const operations = await store.listPlatformOperations({ limit: c.req.query('limit') });
					return c.json({ ok: true, operations: operations.map((operation) => decoratePlatformOperation(runtime.resolved.config.baseUrl, operation)) });
				});
	
	app.post('/v1/platform/operations', async (c) => {
					const auth = await ensurePrincipal(c);
					if (auth.response) return auth.response;
					if (isTeamApiPrincipal(auth.principal) && !principalHasPermission(auth.principal, 'platform:operations:create')) {
						return jsonError(c, 403, 'Permission denied.', { permission: 'platform:operations:create' });
					}
					const body = await c.req.json().catch(() => ({}));
					const namespace = optionalTrimmedString(body.namespace);
					const operationName = optionalTrimmedString(body.operation);
					if (!namespace || !operationName) return jsonError(c, 400, 'namespace and operation are required.');
					const input = body.input && typeof body.input === 'object' && !Array.isArray(body.input) ? body.input : {};
					const approvalRequired = input.approvalRequired === true && input.approvalSatisfied !== true;
					const operation = await store.createPlatformOperation({
						namespace,
						operation: operationName,
						target: optionalTrimmedString(body.target) ?? 'market_operations_runner',
						status: approvalRequired ? 'waiting_for_approval' : optionalTrimmedString(body.status) ?? 'queued',
						idempotencyKey: optionalTrimmedString(body.idempotencyKey),
						input,
						requestedByType: isTeamApiPrincipal(auth.principal) ? 'team_api_key' : c.get('actorType') === 'service' ? 'service' : 'user',
						requestedById: auth.principal.id,
					});
					return c.json({ ok: true, operation: decoratePlatformOperation(runtime.resolved.config.baseUrl, operation) }, { status: 202 });
				});
	
	app.get('/v1/platform/operations/:operationId', async (c) => {
					const auth = await ensurePrincipal(c);
					if (auth.response) return auth.response;
					if (isTeamApiPrincipal(auth.principal) && !principalHasPermission(auth.principal, 'platform:operations:read')) {
						return jsonError(c, 403, 'Permission denied.', { permission: 'platform:operations:read' });
					}
					const operation = await store.findPlatformOperationById(c.req.param('operationId'));
					if (!operation) return jsonError(c, 404, `Unknown platform operation "${c.req.param('operationId')}".`);
					return c.json({ ok: true, operation: decoratePlatformOperation(runtime.resolved.config.baseUrl, operation) });
				});
	
	app.get('/v1/platform/operations/:operationId/events', async (c) => {
					const auth = await ensurePrincipal(c);
					if (auth.response) return auth.response;
					if (isTeamApiPrincipal(auth.principal) && !principalHasPermission(auth.principal, 'platform:operations:read')) {
						return jsonError(c, 403, 'Permission denied.', { permission: 'platform:operations:read' });
					}
					const operation = await store.findPlatformOperationById(c.req.param('operationId'));
					if (!operation) return jsonError(c, 404, `Unknown platform operation "${c.req.param('operationId')}".`);
					return c.json({ ok: true, events: await store.listPlatformOperationEvents(operation.id) });
				});
	
	app.post('/v1/platform/operations/:operationId/cancel', async (c) => {
					const auth = await ensurePrincipal(c);
					if (auth.response) return auth.response;
					if (isTeamApiPrincipal(auth.principal) && !principalHasPermission(auth.principal, 'platform:operations:cancel')) {
						return jsonError(c, 403, 'Permission denied.', { permission: 'platform:operations:cancel' });
					}
					const operation = await store.findPlatformOperationById(c.req.param('operationId'));
					if (!operation) return jsonError(c, 404, `Unknown platform operation "${c.req.param('operationId')}".`);
					const cancelled = await store.cancelPlatformOperation(operation.id);
					return c.json({ ok: true, operation: decoratePlatformOperation(runtime.resolved.config.baseUrl, cancelled) });
				});
	
	app.post('/v1/platform/operations/:operationId/retry', async (c) => {
					const auth = await ensurePrincipal(c);
					if (auth.response) return auth.response;
					if (isTeamApiPrincipal(auth.principal) && !principalHasPermission(auth.principal, 'platform:operations:retry')) {
						return jsonError(c, 403, 'Permission denied.', { permission: 'platform:operations:retry' });
					}
					const operation = await store.findPlatformOperationById(c.req.param('operationId'));
					if (!operation) return jsonError(c, 404, `Unknown platform operation "${c.req.param('operationId')}".`);
					if (!['failed', 'cancelled'].includes(operation.status)) {
						return jsonError(c, 409, 'Only failed or cancelled platform operations can be retried.', { status: operation.status });
					}
					const body = await c.req.json().catch(() => ({}));
					const retried = await store.retryPlatformOperation(operation.id, {
						inputPatch: body.inputPatch && typeof body.inputPatch === 'object' ? body.inputPatch : {},
					});
					return c.json({ ok: true, operation: decoratePlatformOperation(runtime.resolved.config.baseUrl, retried) }, { status: 202 });
				});
	
	app.post('/v1/platform/runners/register', async (c) => {
					const auth = await requirePlatformRunner(c, runtime.resolved.config);
					if (auth.response) return auth.response;
					const body = await c.req.json().catch(() => ({}));
					const runnerId = optionalTrimmedString(body.runnerId);
					if (!runnerId) return jsonError(c, 400, 'runnerId is required.');
					const runner = await store.upsertMarketOperationRunner({
						runnerId,
						runnerKey: optionalTrimmedString(body.runnerKey) ?? runnerId,
						name: optionalTrimmedString(body.name) ?? runnerId,
						environment: optionalTrimmedString(body.environment) ?? optionalTrimmedString(body.marketId) ?? 'unknown',
						version: optionalTrimmedString(body.version),
						capabilities: Array.isArray(body.capabilities) ? body.capabilities.map(String) : [],
						maxConcurrentJobs: body.maxConcurrentJobs,
						metadata: body.metadata && typeof body.metadata === 'object' ? body.metadata : {},
					});
					return c.json({ ok: true, runner });
				});
	
	app.post('/v1/platform/runners/heartbeat', async (c) => {
					const auth = await requirePlatformRunner(c, runtime.resolved.config);
					if (auth.response) return auth.response;
					const body = await c.req.json().catch(() => ({}));
					const runnerId = optionalTrimmedString(body.runnerId);
					if (!runnerId) return jsonError(c, 400, 'runnerId is required.');
					const runner = await store.upsertMarketOperationRunner({
						runnerId,
						runnerKey: optionalTrimmedString(body.runnerKey) ?? runnerId,
						name: optionalTrimmedString(body.name) ?? runnerId,
						environment: optionalTrimmedString(body.environment) ?? optionalTrimmedString(body.marketId) ?? 'unknown',
						status: optionalTrimmedString(body.status) ?? 'online',
						version: optionalTrimmedString(body.version),
						capabilities: Array.isArray(body.capabilities) ? body.capabilities.map(String) : [],
						activeJobCount: body.activeJobCount,
						maxConcurrentJobs: body.maxConcurrentJobs,
						metadata: body.metadata && typeof body.metadata === 'object' ? body.metadata : {},
					});
					return c.json({ ok: true, runner });
				});
	
	app.post('/v1/platform/runners/jobs/claim', async (c) => {
					const auth = await requirePlatformRunner(c, runtime.resolved.config);
					if (auth.response) return auth.response;
					const body = await c.req.json().catch(() => ({}));
					const runnerId = optionalTrimmedString(body.runnerId);
					if (!runnerId) return jsonError(c, 400, 'runnerId is required.');
					const operation = await store.claimPlatformOperation({
						runnerId,
						operationId: optionalTrimmedString(body.operationId),
						capabilities: Array.isArray(body.capabilities) ? body.capabilities.map(String) : [],
						limit: body.limit,
						leaseSeconds: body.leaseSeconds,
					});
					return c.json({ ok: true, operation: decoratePlatformOperation(runtime.resolved.config.baseUrl, operation) });
				});
	
	app.get('/v1/platform/runners/jobs/:operationId', async (c) => {
					const auth = await requirePlatformRunner(c, runtime.resolved.config);
					if (auth.response) return auth.response;
					const operation = await store.findPlatformOperationById(c.req.param('operationId'));
					if (!operation) return jsonError(c, 404, `Unknown platform operation "${c.req.param('operationId')}".`);
					return c.json({ ok: true, operation: decoratePlatformOperation(runtime.resolved.config.baseUrl, operation) });
				});
	
	app.post('/v1/platform/runners/jobs/:operationId/events', async (c) => {
					const auth = await requirePlatformRunner(c, runtime.resolved.config);
					if (auth.response) return auth.response;
					const operation = await store.findPlatformOperationById(c.req.param('operationId'));
					if (!operation) return jsonError(c, 404, `Unknown platform operation "${c.req.param('operationId')}".`);
					const body = await c.req.json().catch(() => ({}));
					const runnerId = optionalTrimmedString(body.runnerId);
					if (runnerId && operation.assignedRunnerId && operation.assignedRunnerId !== runnerId) {
						return jsonError(c, 409, 'Platform operation is assigned to a different runner.', { assignedRunnerId: operation.assignedRunnerId });
					}
					const event = body.event && typeof body.event === 'object' ? body.event : body;
					const kind = optionalTrimmedString(event.kind) ?? 'runner.event';
					const data = event.data && typeof event.data === 'object' ? event.data : {};
					return c.json({ ok: true, event: await store.appendPlatformOperationEvent(operation.id, kind, data) });
				});
	
	app.post('/v1/platform/runners/jobs/:operationId/checkpoint', async (c) => {
					const auth = await requirePlatformRunner(c, runtime.resolved.config);
					if (auth.response) return auth.response;
					const operation = await store.findPlatformOperationById(c.req.param('operationId'));
					if (!operation) return jsonError(c, 404, `Unknown platform operation "${c.req.param('operationId')}".`);
					const body = await c.req.json().catch(() => ({}));
					let checkpointed;
					try {
						checkpointed = await store.checkpointPlatformOperation(operation.id, {
							runnerId: optionalTrimmedString(body.runnerId),
							output: body.output,
							event: body.event,
						});
					} catch (error) {
						return platformOperationMutationError(c, error);
					}
					return c.json({ ok: true, operation: decoratePlatformOperation(runtime.resolved.config.baseUrl, checkpointed) });
				});
	
	app.post('/v1/platform/runners/jobs/:operationId/renew-lease', async (c) => {
					const auth = await requirePlatformRunner(c, runtime.resolved.config);
					if (auth.response) return auth.response;
					const operation = await store.findPlatformOperationById(c.req.param('operationId'));
					if (!operation) return jsonError(c, 404, `Unknown platform operation "${c.req.param('operationId')}".`);
					const body = await c.req.json().catch(() => ({}));
					let renewed;
					try {
						renewed = await store.renewPlatformOperationLease(operation.id, {
							runnerId: optionalTrimmedString(body.runnerId),
							leaseSeconds: body.leaseSeconds,
							event: body.event,
						});
					} catch (error) {
						return platformOperationMutationError(c, error);
					}
					return c.json({ ok: true, operation: decoratePlatformOperation(runtime.resolved.config.baseUrl, renewed) });
				});
	
	app.post('/v1/platform/runners/jobs/:operationId/cancel', async (c) => {
					const auth = await requirePlatformRunner(c, runtime.resolved.config);
					if (auth.response) return auth.response;
					const operation = await store.findPlatformOperationById(c.req.param('operationId'));
					if (!operation) return jsonError(c, 404, `Unknown platform operation "${c.req.param('operationId')}".`);
					const body = await c.req.json().catch(() => ({}));
					const runnerId = optionalTrimmedString(body.runnerId);
					if (runnerId && operation.assignedRunnerId && operation.assignedRunnerId !== runnerId) {
						return jsonError(c, 409, 'Platform operation is assigned to a different runner.', { assignedRunnerId: operation.assignedRunnerId });
					}
					const cancelled = await store.cancelPlatformOperation(operation.id);
					const event = body.event && typeof body.event === 'object' ? body.event : null;
					if (event) {
						await store.appendPlatformOperationEvent(operation.id, optionalTrimmedString(event.kind) ?? 'runner.cancelled', event.data && typeof event.data === 'object' ? event.data : {});
					}
					return c.json({ ok: true, operation: decoratePlatformOperation(runtime.resolved.config.baseUrl, cancelled) });
				});
	
	app.post('/v1/platform/runners/jobs/:operationId/complete', async (c) => {
					const auth = await requirePlatformRunner(c, runtime.resolved.config);
					if (auth.response) return auth.response;
					const operation = await store.findPlatformOperationById(c.req.param('operationId'));
					if (!operation) return jsonError(c, 404, `Unknown platform operation "${c.req.param('operationId')}".`);
					const body = await c.req.json().catch(() => ({}));
					let completed;
					try {
						completed = await store.completePlatformOperation(operation.id, {
							runnerId: optionalTrimmedString(body.runnerId),
							output: body.output,
							event: body.event,
						});
					} catch (error) {
						return platformOperationMutationError(c, error);
					}
					return c.json({ ok: true, operation: decoratePlatformOperation(runtime.resolved.config.baseUrl, completed) });
				});
	
	app.post('/v1/platform/runners/jobs/:operationId/fail', async (c) => {
					const auth = await requirePlatformRunner(c, runtime.resolved.config);
					if (auth.response) return auth.response;
					const operation = await store.findPlatformOperationById(c.req.param('operationId'));
					if (!operation) return jsonError(c, 404, `Unknown platform operation "${c.req.param('operationId')}".`);
					const body = await c.req.json().catch(() => ({}));
					let failed;
					try {
						failed = await store.failPlatformOperation(operation.id, {
							runnerId: optionalTrimmedString(body.runnerId),
							error: body.error ?? { message: 'Platform operation failed.' },
							event: body.event,
						});
					} catch (error) {
						return platformOperationMutationError(c, error);
					}
					return c.json({ ok: true, operation: decoratePlatformOperation(runtime.resolved.config.baseUrl, failed) });
				});
}
