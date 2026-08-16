export function installProjectsCollectionRoutes(context: any) {
	const { app, capacity, ensurePrincipal, jsonError, requireProjectAccess, requireTeamAccess, store } = context;
	
	app.get('/v1/projects', async (c) => {
					const auth = await ensurePrincipal(c);
					if (auth.response) return auth.response;
					const teamId = typeof c.req.query('teamId') === 'string' ? c.req.query('teamId') : null;
					if (teamId) {
						const access = await requireTeamAccess(c, store, teamId, 'projects:read:team');
						if (access.response) return access.response;
						const projects = await store.listTeamProjects(teamId);
						return c.json({
							ok: true,
							payload: projects.filter((project) => project.teamId === teamId && project.metadata?.inventory?.status !== 'archived'),
						});
					}
					return c.json({
						ok: true,
						payload: await store.listProjectsForPrincipal(auth.principal),
					});
	});

	app.get('/v1/teams/:teamId/project-inventory', async (c) => {
		const teamId = c.req.param('teamId');
		const access = await requireTeamAccess(c, store, teamId, 'projects:read:team');
		if (access.response) return access.response;
		const projects = (await store.listTeamProjects(teamId)).filter((project) => project.metadata?.inventory?.status !== 'archived');
		return c.json({
			ok: true,
			payload: {
				teamId,
				projects: await Promise.all(projects.map(async (project) => ({
					...project,
					repositories: await store.listHubRepositories(project.id),
				}))),
			},
		});
	});

	app.post('/v1/projects/:projectId/archive', async (c) => {
		const projectId = c.req.param('projectId');
		const access = await requireProjectAccess(c, store, projectId, 'projects:manage:team');
		if (access.response) return access.response;
		const project = await store.getProject(projectId);
		if (!project) return jsonError(c, 404, 'Project not found.');
		const blockers = await capacity.evaluateProjectDeletionBlockers(projectId);
		if (blockers.length > 0) return jsonError(c, 409, 'Project still has active work and cannot be archived.', { code: 'blocked', blockers });
		const updated = await store.updateProject(projectId, { metadata: { ...project.metadata, inventory: { status: 'archived', archivedAt: new Date().toISOString(), archivedBy: access.principal.id } } });
		await store.recordAuditEvent({ actorType: 'user', eventType: 'project.archived', actorId: access.principal.id,
			targetType: 'project', targetId: projectId, data: { teamId: project.teamId, slug: project.slug } });
		return c.json({ ok: true, payload: updated });
	});

	app.post('/v1/projects/:projectId/restore', async (c) => {
		const projectId = c.req.param('projectId');
		const access = await requireProjectAccess(c, store, projectId, 'projects:manage:team');
		if (access.response) return access.response;
		const project = await store.getProject(projectId);
		if (!project) return jsonError(c, 404, 'Project not found.');
		const updated = await store.updateProject(projectId, { metadata: { ...project.metadata, inventory: { status: 'active', restoredAt: new Date().toISOString(), restoredBy: access.principal.id } } });
		await store.recordAuditEvent({ actorType: 'user', eventType: 'project.restored', actorId: access.principal.id,
			targetType: 'project', targetId: projectId, data: { teamId: project.teamId, slug: project.slug } });
		return c.json({ ok: true, payload: updated });
	});
	
	app.post('/v1/teams/:teamId/projects', async (c) => {
					const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'projects:manage:team');
					if (access.response) return access.response;
					const body = await c.req.json().catch(() => ({}));
					if (!body.slug || !body.name) {
						return jsonError(c, 400, 'slug and name are required.');
					}
					let details;
					try {
						details = await store.createProject(c.req.param('teamId'), {
							id: typeof body.id === 'string' ? body.id : undefined,
							slug: String(body.slug),
							name: String(body.name),
							description: typeof body.description === 'string' ? body.description : null,
							metadata: typeof body.metadata === 'object' && body.metadata ? body.metadata : {},
							entitlementTier: typeof body.entitlementTier === 'string' ? body.entitlementTier : 'free',
						});
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						const status = /already in use/u.test(message) ? 409 : 400;
						return jsonError(c, status, message, { code: status === 409 ? 'slug_taken' : 'invalid_slug' });
					}
					return c.json({ ok: true, payload: details });
				});

	app.get('/v1/projects/:projectId/deletion-blockers', async (c) => {
		const projectId = c.req.param('projectId');
		const access = await requireProjectAccess(c, store, projectId, 'projects:manage:team');
		if (access.response) return access.response;
		return c.json({ ok: true, payload: await capacity.evaluateProjectDeletionBlockers(projectId) });
	});

	app.delete('/v1/projects/:projectId', async (c) => {
		const projectId = c.req.param('projectId');
		const access = await requireProjectAccess(c, store, projectId, 'projects:manage:team');
		if (access.response) return access.response;
		const body = await c.req.json().catch(() => ({}));
		const project = await store.getProject(projectId);
		if (!project) return jsonError(c, 404, 'Project not found.');
		if (String(body.confirmation ?? '') !== `DELETE ${project.slug}`) {
			return jsonError(c, 400, `Type DELETE ${project.slug} to confirm.`, { code: 'confirmation' });
		}
		const blockers = await capacity.evaluateProjectDeletionBlockers(projectId);
		if (blockers.length > 0) {
			return jsonError(c, 409, 'Project still has active work that must finish before deletion.', {
				code: 'blocked',
				blockers,
			});
		}
		await store.run('DELETE FROM projects WHERE id = ?', [projectId]);
		await store.recordAuditEvent({
			actorType: 'user',
			eventType: 'project.deleted',
			actorId: access.principal.id,
			targetType: 'project',
			targetId: projectId,
			data: { teamId: project.teamId, slug: project.slug },
		});
		return c.json({ ok: true, payload: { id: projectId, deleted: true } });
	});
}
