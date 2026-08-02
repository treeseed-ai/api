export function installOperationsProjectJobsRoutes(context: any) {
	const { app, decorateJob, ensurePrincipal, jsonError, requireProjectAccess, runtime, store } = context;

	const loadAuthorizedJob = async (c: any, permission: string) => {
		const auth = await ensurePrincipal(c);
		if (auth.response) return auth;
		const job = await store.findJobById(c.req.param('jobId'));
		if (!job) return { response: jsonError(c, 404, `Unknown job "${c.req.param('jobId')}".`) };
		const access = await requireProjectAccess(c, store, job.projectId, permission);
		return access.response ? { response: access.response } : { job, access };
	};

	app.get('/v1/jobs/:jobId', async (c: any) => {
		const result = await loadAuthorizedJob(c, 'dispatch:execute:team');
		if (result.response) return result.response;
		return c.json({ ok: true, payload: decorateJob(runtime.resolved.config.baseUrl, result.job) });
	});

	app.post('/v1/jobs/:jobId/cancel', async (c: any) => {
		const result = await loadAuthorizedJob(c, 'dispatch:execute:team');
		if (result.response) return result.response;
		return c.json({
			ok: true,
			payload: decorateJob(runtime.resolved.config.baseUrl, await store.cancelJob(result.job.id)),
		});
	});

	const retryJob = async (c: any, resume: boolean) => {
		const result = await loadAuthorizedJob(c, 'dispatch:execute:team');
		if (result.response) return result.response;
		if (!['failed', 'cancelled'].includes(result.job.status)) {
			return jsonError(c, 409, `Only failed or cancelled jobs can be ${resume ? 'resumed' : 'retried'}.`, {
				status: result.job.status,
			});
		}
		const job = await store.retryJob(result.job.id, {
			status: 'pending',
			inputPatch: { resume },
			eventType: resume ? 'resume_queued' : 'retry_queued',
		});
		return c.json({ ok: true, payload: decorateJob(runtime.resolved.config.baseUrl, job) }, { status: 202 });
	};

	app.post('/v1/jobs/:jobId/retry', (c: any) => retryJob(c, false));
	app.post('/v1/jobs/:jobId/resume', (c: any) => retryJob(c, true));

	app.post('/v1/jobs/:jobId/approve', async (c: any) => {
		const result = await loadAuthorizedJob(c, 'projects:manage:team');
		if (result.response) return result.response;
		if (c.get('actorType') === 'service') {
			return jsonError(c, 403, 'Service principals cannot approve project work.');
		}
		if (result.job.status !== 'waiting_for_approval') {
			return jsonError(c, 409, 'This job is not waiting for approval.', { status: result.job.status });
		}
		const body = await c.req.json().catch(() => ({}));
		await store.appendJobEvent(result.job.id, 'approved', {
			approvedBy: result.access.principal.id,
			note: typeof body.note === 'string' ? body.note : null,
		});
		const approved = await store.retryJob(result.job.id, {
			status: 'pending',
			inputPatch: {
				approvalReference: {
					approvedBy: result.access.principal.id,
					approvedAt: new Date().toISOString(),
					note: typeof body.note === 'string' ? body.note : null,
				},
			},
			eventType: 'approval_released',
		});
		const teamId = typeof result.job.input?.teamId === 'string'
			? result.job.input.teamId
			: result.access.details.project.teamId;
		await store.deleteTeamInboxItemsByItemKey(teamId, result.job.id);
		return c.json({ ok: true, payload: decorateJob(runtime.resolved.config.baseUrl, approved) }, { status: 202 });
	});

	app.post('/v1/jobs/:jobId/reject', async (c: any) => {
		const result = await loadAuthorizedJob(c, 'projects:manage:team');
		if (result.response) return result.response;
		if (c.get('actorType') === 'service') {
			return jsonError(c, 403, 'Service principals cannot decide approval requests.');
		}
		if (result.job.status !== 'waiting_for_approval') {
			return jsonError(c, 409, 'This job is not waiting for approval.', { status: result.job.status });
		}
		const body = await c.req.json().catch(() => ({}));
		const rejected = await store.failJob(result.job.id, {
			code: 'approval_rejected',
			message: typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim() : 'Approval rejected.',
		});
		const teamId = typeof result.job.input?.teamId === 'string'
			? result.job.input.teamId
			: result.access.details.project.teamId;
		await store.deleteTeamInboxItemsByItemKey(teamId, result.job.id);
		return c.json({ ok: true, payload: decorateJob(runtime.resolved.config.baseUrl, rejected) });
	});
}
