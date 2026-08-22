export function installProjectsSettingsAndSummariesRoutes(context: any) {
	const { app, jsonError, markdownToPlainProjectSummary, principalHasPermission, recordPrivateKnowledgeAudit, requireProjectAccess, safePrivateKnowledgeSlug, store, validateProjectSlug } = context;
	
	app.put('/v1/projects/:projectId', async (c) => {
					const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:manage:team');
					if (access.response) return access.response;
					const body = await c.req.json().catch(() => ({}));
					const slugResult = body.slug == null ? { ok: true, slug: access.details.project.slug } : validateProjectSlug(body.slug);
					if (!slugResult.ok) return jsonError(c, 400, slugResult.message, { code: slugResult.code });
					const name = String(body.name ?? access.details.project.name).trim();
					if (!name) return jsonError(c, 400, 'Project name is required.', { code: 'missing_name' });
					const existing = slugResult.slug === access.details.project.slug
						? null
						: await store.getProjectByTeamAndSlug(access.details.project.teamId, slugResult.slug);
					if (existing && existing.id !== c.req.param('projectId')) {
						return jsonError(c, 409, 'That project slug is already in use for this team.', { code: 'slug_taken' });
					}
					const metadataInput = body.metadata && typeof body.metadata === 'object' ? body.metadata : {};
					const requestedCoreObjective = typeof body.coreObjective === 'string'
						? body.coreObjective.trim()
						: typeof metadataInput.coreObjective === 'string'
							? metadataInput.coreObjective.trim()
							: null;
					const existingCoreObjective = typeof access.details.project.metadata?.coreObjective === 'string'
						? access.details.project.metadata.coreObjective.trim()
						: String(access.details.project.description ?? '').trim();
					const shouldSyncCoreObjective = requestedCoreObjective != null && requestedCoreObjective !== existingCoreObjective;
					if (shouldSyncCoreObjective) {
						return jsonError(c, 409, 'Core objective content must be updated through an atomic TreeDX changeset before project metadata is changed.', {
							code: 'treedx_changeset_required',
						});
					}
					const description = typeof body.description === 'string'
						? body.description.trim() || null
						: requestedCoreObjective != null
							? markdownToPlainProjectSummary(requestedCoreObjective, null)
							: access.details.project.description ?? null;
					const updated = await store.updateProject(c.req.param('projectId'), {
						slug: slugResult.slug,
						name,
						description,
						metadata: {
							...(access.details.project.metadata ?? {}),
							...metadataInput,
							...(requestedCoreObjective != null ? { coreObjective: requestedCoreObjective } : {}),
						},
					});
					return c.json({
						ok: true,
						payload: await store.getProjectDetails(updated.id),
					});
				});
	
	app.post('/v1/projects/:projectId/private-knowledge/access', async (c) => {
					const projectId = c.req.param('projectId');
					const body = await c.req.json().catch(() => ({}));
					const principal = c.get('principal');
					if (!principal) {
						return jsonError(c, 401, 'Authentication required.');
					}
					const details = await store.getProjectDetails(projectId);
					if (!details?.project) {
						await recordPrivateKnowledgeAudit(store, {
							eventType: 'private_knowledge.not_found',
							actorId: principal.id,
							projectId,
							body,
							status: 'not_found',
							summary: 'Private knowledge project was not found.',
						});
						return jsonError(c, 404, 'Private knowledge page not found.');
					}
					const teamContext = await store.resolvePrincipalTeamContext(details.project.teamId, principal);
					const allowed = Boolean(teamContext) && (!isTeamApiPrincipal(principal) || principalHasPermission(principal, 'projects:read:team'));
					if (!allowed) {
						await recordPrivateKnowledgeAudit(store, {
							eventType: 'private_knowledge.denied',
							actorId: principal.id,
							projectId: details.project.id,
							body,
							status: 'denied',
							summary: 'Private knowledge access was denied.',
						});
						return jsonError(c, 403, 'Permission denied.');
					}
					const outcome = typeof body.outcome === 'string' ? body.outcome : 'validate';
					if (outcome === 'read' || outcome === 'not_found') {
						await recordPrivateKnowledgeAudit(store, {
							eventType: outcome === 'read' ? 'private_knowledge.read' : 'private_knowledge.not_found',
							actorId: principal.id,
							projectId: details.project.id,
							body,
							status: outcome,
							summary: outcome === 'read' ? 'Private knowledge page was read.' : 'Private knowledge page was not found.',
						});
					}
					return c.json({
						ok: true,
						payload: {
							project: {
								id: details.project.id,
								teamId: details.project.teamId,
								name: details.project.name ?? details.project.slug ?? details.project.id,
								slug: details.project.slug ?? details.project.id,
							},
							team: {
								teamId: details.project.teamId,
								roles: teamContext.roles,
							},
							slug: safePrivateKnowledgeSlug(body.slug),
						},
					});
				});
	
	app.get('/v1/projects/:projectId/direct', async (c) => {
					const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:read:team');
					if (access.response) return access.response;
					return c.json({
						ok: true,
						payload: await store.getProjectDirectSummary(c.req.param('projectId'), access.principal),
					});
				});
	
	app.get('/v1/projects/:projectId/workstreams', async (c) => {
					const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:read:team');
					if (access.response) return access.response;
					return c.json({
						ok: true,
						payload: await store.getProjectWorkstreamsSummary(c.req.param('projectId'), access.principal),
					});
				});
	
	app.get('/v1/projects/:projectId/share', async (c) => {
					const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:read:team');
					if (access.response) return access.response;
					return c.json({
						ok: true,
						payload: await store.getProjectShareSummary(c.req.param('projectId'), access.principal),
					});
				});
}
