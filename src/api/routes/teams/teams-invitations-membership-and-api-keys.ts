export function installTeamsInvitationsMembershipAndApiKeysRoutes(context: any) {
	const { app, authEmailDeliveryFailureDetail, authEmailDeliveryFailureReason, capacity, config, exportSeedWithStore, jsonError, controlPlaneAuthContext, normalizeSeedEnvironments, requireTeamAccess, runtime, sendTeamInviteEmail, shouldExposeNonProductionAuthDiagnostics, store } = context;
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
	
	app.post('/v1/teams/:teamId/invites', async (c) => {
					const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'teams:manage:team');
					if (access.response) return access.response;
					if ((await store.getTeam(c.req.param('teamId')))?.status === 'archived') return jsonError(c, 409, 'Archived teams are read-only.', { code: 'team_archived' });
					const body = await c.req.json().catch(() => ({}));
					const result = await store.createTeamInvite(c.req.param('teamId'), {
						email: body.email,
						roleKey: body.roleKey ?? body.role,
						invitedByUserId: access.principal.id,
					});
					if (result.ok && result.invite && result.token) {
						try {
							const team = await store.getTeam(c.req.param('teamId'));
							await sendTeamInviteEmail(controlPlaneAuthContext(c, config), {
								invite: result.invite,
								team,
								token: result.token,
							});
						} catch (error) {
							console.warn('[team-invite] Email delivery failed:', error instanceof Error ? error.message : String(error));
							await store.revokeTeamInvite(c.req.param('teamId'), result.invite.id);
							const reason = authEmailDeliveryFailureReason(error);
							return jsonError(c, 503, 'Team invite email could not be sent. Please try again shortly.', {
								code: 'team_invite_delivery_failed',
								reason,
								...(shouldExposeNonProductionAuthDiagnostics(c, runtime) ? { detail: authEmailDeliveryFailureDetail(error) } : {}),
							});
						}
						await store.recordAuditEvent({
							actorType: 'user', actorId: access.principal.id, eventType: 'team.invitation.created',
							targetType: 'team', targetId: c.req.param('teamId'),
							data: {
								invitationId: result.invite.id,
								recipientEmail: result.invite.email,
								roleKey: result.invite.roleKey,
							},
						});
					}
					return c.json(result, teamMutationStatus(result));
				});
	
	app.patch('/v1/teams/:teamId/members/:membershipId', async (c) => {
					const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'teams:manage:team');
					if (access.response) return access.response;
					if ((await store.getTeam(c.req.param('teamId')))?.status === 'archived') return jsonError(c, 409, 'Archived teams are read-only.', { code: 'team_archived' });
					const body = await c.req.json().catch(() => ({}));
					const requestedRole = String(body.roleKey ?? body.role ?? 'contributor');
					const members = await store.listTeamMembers(c.req.param('teamId'));
					const targetMember = members.find((member) => member.id === c.req.param('membershipId'));
					const targetRoles = await store.listRoleKeysForMembership(c.req.param('membershipId'));
					if ((requestedRole === 'team_owner' || targetRoles.includes('team_owner'))
						&& !await actorOwnsTeam(c.req.param('teamId'), access.principal)) {
						return jsonError(c, 403, 'Only team owners can grant or remove ownership.', { code: 'owner_required' });
					}
					const result = await store.updateTeamMemberRole(
						c.req.param('teamId'),
						c.req.param('membershipId'),
						requestedRole,
						typeof body.expectedVersion === 'string' ? body.expectedVersion : undefined,
					);
					if (result.ok) await store.recordAuditEvent({
						actorType: 'user', actorId: access.principal.id, eventType: 'team.member.role_changed',
						targetType: 'team', targetId: c.req.param('teamId'),
						data: {
							membershipId: c.req.param('membershipId'),
							subjectDisplayName: targetMember?.displayName,
							subjectEmail: targetMember?.email,
							previousRoleKey: targetMember?.roleKey,
							roleKey: requestedRole,
						},
					});
					return c.json(result, teamMutationStatus(result));
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
	
	app.delete('/v1/teams/:teamId/members/:membershipId', async (c) => {
					const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'teams:manage:team');
					if (access.response) return access.response;
					if ((await store.getTeam(c.req.param('teamId')))?.status === 'archived') return jsonError(c, 409, 'Archived teams are read-only.', { code: 'team_archived' });
					const body = await c.req.json().catch(() => ({}));
					const members = await store.listTeamMembers(c.req.param('teamId'));
					const targetMember = members.find((member) => member.id === c.req.param('membershipId'));
					const targetRoles = await store.listRoleKeysForMembership(c.req.param('membershipId'));
					if (targetRoles.includes('team_owner') && !await actorOwnsTeam(c.req.param('teamId'), access.principal)) {
						return jsonError(c, 403, 'Only team owners can remove an owner.', { code: 'owner_required' });
					}
					const result = await store.removeTeamMember(
						c.req.param('teamId'),
						c.req.param('membershipId'),
						typeof body.expectedVersion === 'string' ? body.expectedVersion : undefined,
					);
					if (result.ok) await store.recordAuditEvent({
						actorType: 'user', actorId: access.principal.id, eventType: 'team.member.removed',
						targetType: 'team', targetId: c.req.param('teamId'),
						data: {
							membershipId: c.req.param('membershipId'),
							subjectDisplayName: targetMember?.displayName,
							subjectEmail: targetMember?.email,
							roleKey: targetMember?.roleKey,
						},
					});
					return c.json(result, teamMutationStatus(result));
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
