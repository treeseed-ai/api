export function installTeamsInvitationsMembershipAndApiKeysRoutes(context: any) {
	const { app, capacity, exportSeedWithStore, jsonError, normalizeSeedEnvironments, requireTeamAccess, store } = context;
	const actorOwnsTeam = async (teamId: string, principal: any) => {
		const teamContext = await store.resolvePrincipalTeamContext(teamId, principal);
		return teamContext?.roles?.includes('team_owner') === true;
	};
	const teamMutationStatus = (result: { ok?: boolean; code?: string } | null) => {
		if (!result) return 404;
		if (result.ok) return 200;
		if (result.code === 'missing') return 404;
		if (['stale', 'invite_already_pending', 'namespace_taken', 'taken'].includes(String(result.code))) return 409;
		return 400;
	};
	app.get('/v1/teams/:teamId/home', async (c) => {
					const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'projects:read:team');
					if (access.response) return access.response;
					return c.json({
						ok: true,
						payload: await store.getTeamHomeSummary(c.req.param('teamId'), access.principal, capacity),
					});
				});
	
	app.get('/v1/teams/:teamId/inbox', async (c) => {
					const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'projects:read:team');
					if (access.response) return access.response;
					return c.json({
						ok: true,
						payload: await store.listTeamInboxItems(c.req.param('teamId'), access.principal),
					});
				});
	
	app.get('/v1/teams/:teamId/approval-requests', async (c) => {
					const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'projects:read:team');
					if (access.response) return access.response;
					const limit = Number(c.req.query('limit') ?? 50);
					const kind = c.req.query('kind');
					return c.json({
						ok: true,
						payload: await store.listApprovalRequestsForTeam(c.req.param('teamId'), { kind, limit }),
					});
				});
	
	app.get('/v1/teams/:teamId/permissions', async (c) => {
					const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'projects:read:team');
					if (access.response) return access.response;
					return c.json({
						ok: true,
						payload: await store.getTeamAccessSummary(c.req.param('teamId'), access.principal),
					});
				});
	
	app.get('/v1/teams/:teamId/products', async (c) => {
					const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'projects:read:team');
					if (access.response) return access.response;
					return c.json({
						ok: true,
						payload: await store.listTeamProducts(c.req.param('teamId'), access.principal),
					});
				});
	
	app.post('/v1/teams/:teamId/seeds/export', async (c) => {
					const body = await c.req.json().catch(() => ({}));
					const includePrivate = body.includePrivate === true;
					const access = await requireTeamAccess(c, store, c.req.param('teamId'), includePrivate ? 'teams:manage:team' : 'projects:read:team');
					if (access.response) return access.response;
					const result = await exportSeedWithStore({
						store,
						teamId: c.req.param('teamId'),
						name: typeof body.name === 'string' && body.name.trim() ? body.name.trim() : 'exported',
						environments: normalizeSeedEnvironments(body.environments),
						includePrivate,
						includeArtifacts: body.includeArtifacts === true,
						principal: access.principal,
					});
					return c.json(result, result.ok ? 200 : 400);
				});
	
	app.get('/v1/teams/:teamId/members/:membershipId/removal-blockers', async (c) => {
					const teamId = c.req.param('teamId');
					const membershipId = c.req.param('membershipId');
					const access = await requireTeamAccess(c, store, teamId, 'teams:manage:team');
					if (access.response) return access.response;
					const members = await store.listTeamMembers(teamId);
					const target = members.find((member) => member.id === membershipId);
					if (!target) return jsonError(c, 404, 'Team member not found.', { code: 'member_missing' });
					const targetIsOwner = target.roles?.includes('team_owner') === true;
					const actorIsOwner = await actorOwnsTeam(teamId, access.principal);
					const ownerCount = members.filter((member) => member.roles?.includes('team_owner')).length;
					const blockers = [
						...(targetIsOwner && !actorIsOwner ? [{
							code: 'owner_required',
							label: 'Only a team owner can remove another owner.',
							href: `/app/teams/${encodeURIComponent(teamId)}/members`,
						}] : []),
						...(targetIsOwner && ownerCount <= 1 ? [{
							code: 'last_owner',
							label: 'Transfer ownership or add another owner before removal.',
							href: `/app/teams/${encodeURIComponent(teamId)}/members`,
						}] : []),
					];
					return c.json({ ok: true, payload: { membershipId, eligible: blockers.length === 0, blockers } });
				});
	
	app.get('/v1/teams/:teamId/deletion-blockers', async (c) => {
					const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'teams:manage:team');
					if (access.response) return access.response;
					return c.json({ ok: true, payload: await store.evaluateTeamDeletionBlockers(c.req.param('teamId')) });
				});
	
	app.post('/v1/teams/:teamId/api-keys', async (c) => {
					const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'teams:manage:team');
					if (access.response) return access.response;
					const body = await c.req.json().catch(() => ({}));
					if (!body.name) {
						return jsonError(c, 400, 'name is required.');
					}
					return c.json({
						ok: true,
						payload: await store.createTeamApiKey(c.req.param('teamId'), {
							name: String(body.name),
							permissions: Array.isArray(body.permissions) ? body.permissions.map(String) : [],
							expiresAt: typeof body.expiresAt === 'string' ? body.expiresAt : null,
						}),
					});
				});
}
