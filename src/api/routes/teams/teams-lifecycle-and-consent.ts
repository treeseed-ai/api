function statusFor(result: { ok?: boolean; code?: string }) {
	if (result.ok) return 200;
	if (result.code === 'missing') return 404;
	if (result.code === 'stale' || result.code === 'stale_or_expired' || result.code === 'invite_already_pending') return 409;
	if (result.code === 'blocked') return 422;
	return 400;
}

export function installTeamsLifecycleAndConsentRoutes(context: any) {
	const { app, config, consumeReauthentication, deleteTeamCapacityAggregate, ensurePrincipal, jsonError, controlPlaneAuthContext, options, sendTeamInviteEmail, store } = context;
	const clockNow = () => options?.clock?.now?.() ?? new Date();

	const requireTeamRole = async (c: any, teamId: string, roles: string[]) => {
		const auth = await ensurePrincipal(c);
		if (auth.response) return { response: auth.response };
		const access = await store.resolvePrincipalTeamContext(teamId, auth.principal);
		if (!access) return { response: jsonError(c, 403, 'Permission denied.', { code: 'team_forbidden' }) };
		if (!roles.some((role) => access.roles.includes(role))) {
			return { response: jsonError(c, 403, 'Permission denied.', { code: 'team_role_forbidden' }) };
		}
		return { principal: auth.principal, access };
	};

	app.get('/v1/teams/:teamId/access', async (c: any) => {
		const auth = await ensurePrincipal(c);
		if (auth.response) return auth.response;
		const teamId = c.req.param('teamId');
		const team = await store.getTeam(teamId);
		if (!team) return jsonError(c, 404, 'Team not found.', { code: 'team_missing' });
		if (!await store.principalCanAccessTeam(auth.principal, teamId)) {
			return jsonError(c, 403, 'Team access denied.', { code: 'team_forbidden' });
		}
		return c.json({
			ok: true,
			payload: {
				team,
				access: await store.getTeamAccessSummary(teamId, auth.principal),
			},
		});
	});

	app.get('/v1/teams/:teamId/invites', async (c: any) => {
		const access = await requireTeamRole(c, c.req.param('teamId'), ['team_owner', 'project_lead']);
		if (access.response) return access.response;
		return c.json({ ok: true, payload: await store.listTeamInvites(c.req.param('teamId')) });
	});

	app.post('/v1/teams/:teamId/invites/:inviteId/resend', async (c: any) => {
		const teamId = c.req.param('teamId');
		const access = await requireTeamRole(c, teamId, ['team_owner', 'project_lead']);
		if (access.response) return access.response;
		const result = await store.resendTeamInvite(teamId, c.req.param('inviteId'));
		if (result.ok && result.invite && result.token) {
			try {
				await sendTeamInviteEmail(controlPlaneAuthContext(c, config), {
					invite: result.invite,
					team: await store.getTeam(teamId),
					token: result.token,
				});
			} catch {
				return jsonError(c, 503, 'Team invitation could not be resent. Try again.', {
					code: 'team_invite_delivery_failed',
				});
			}
			await store.recordAuditEvent({
				actorType: 'user',
				actorId: access.principal.id,
				eventType: 'team.invitation.resent',
				targetType: 'team',
				targetId: teamId,
				data: { invitationId: result.invite.id },
			});
		}
		return c.json(result, statusFor(result));
	});

	app.delete('/v1/teams/:teamId/invites/:inviteId', async (c: any) => {
		const teamId = c.req.param('teamId');
		const access = await requireTeamRole(c, teamId, ['team_owner', 'project_lead']);
		if (access.response) return access.response;
		const result = await store.revokeTeamInvite(teamId, c.req.param('inviteId'));
		if (result.ok) await store.recordAuditEvent({
			actorType: 'user',
			actorId: access.principal.id,
			eventType: 'team.invitation.revoked',
			targetType: 'team',
			targetId: teamId,
			data: { invitationId: c.req.param('inviteId') },
		});
		return c.json(result, statusFor(result));
	});

	app.post('/v1/teams/:teamId/archive', async (c: any) => {
		const teamId = c.req.param('teamId');
		const access = await requireTeamRole(c, teamId, ['team_owner']);
		if (access.response) return access.response;
		const body = await c.req.json().catch(() => ({}));
		const result = await store.archiveTeam(teamId, {
			actorId: access.principal.id,
			lifecycleVersion: Number(body.lifecycleVersion),
			now: clockNow(),
		});
		if (result.ok) await store.recordAuditEvent({
			actorType: 'user', actorId: access.principal.id, eventType: 'team.archived',
			targetType: 'team', targetId: teamId,
		});
		return c.json(result, statusFor(result));
	});

	app.post('/v1/teams/:teamId/restore', async (c: any) => {
		const teamId = c.req.param('teamId');
		const access = await requireTeamRole(c, teamId, ['team_owner']);
		if (access.response) return access.response;
		const body = await c.req.json().catch(() => ({}));
		const result = await store.restoreTeam(teamId, {
			lifecycleVersion: Number(body.lifecycleVersion),
			now: clockNow(),
		});
		if (result.ok) await store.recordAuditEvent({
			actorType: 'user', actorId: access.principal.id, eventType: 'team.restored',
			targetType: 'team', targetId: teamId,
		});
		return c.json(result, statusFor(result));
	});

	app.get('/v1/teams/:teamId/deletion-readiness', async (c: any) => {
		const access = await requireTeamRole(c, c.req.param('teamId'), ['team_owner']);
		if (access.response) return access.response;
		return c.json(await store.getTeamDeletionReadiness(c.req.param('teamId')));
	});

	app.delete('/v1/teams/:teamId/permanent-delete', async (c: any) => {
		const teamId = c.req.param('teamId');
		const access = await requireTeamRole(c, teamId, ['team_owner']);
		if (access.response) return access.response;
		const body = await c.req.json().catch(() => ({}));
		const readiness = await store.getTeamDeletionReadiness(teamId);
		if (!readiness.ok) return c.json({ ...readiness, ok: false, code: 'deletion_blocked' }, 422);
		if (!readiness.ready) return c.json({ ...readiness, ok: false, code: 'deletion_blocked' }, 422);
		if (body.confirmation !== readiness.team.name) return jsonError(c, 400, `Type ${readiness.team.name} to confirm.`, { code: 'confirmation' });
		if (!await consumeReauthentication(store, access.principal, 'team_delete', body)) {
			return jsonError(c, 401, 'Reauthentication is required.', { code: 'reauthentication_required' });
		}
		const result = await deleteTeamCapacityAggregate(store, teamId, `DELETE ${readiness.team.name}`);
		if (result.ok) await store.recordAuditEvent({
			actorType: 'user', actorId: access.principal.id, eventType: 'team.deleted',
			targetType: 'team', targetId: teamId, data: { name: readiness.team.name, tombstone: true },
		});
		return c.json(result, statusFor(result));
	});

	app.post('/v1/teams/:teamId/ownership-transfer', async (c: any) => {
		const teamId = c.req.param('teamId');
		const access = await requireTeamRole(c, teamId, ['team_owner']);
		if (access.response) return access.response;
		const body = await c.req.json().catch(() => ({}));
		const members = await store.listTeamMembers(teamId);
		const actor = members.find((member: any) => member.userId === access.principal.id);
		if (!actor) return jsonError(c, 403, 'Owner membership not found.');
		const result = await store.transferTeamOwnership(teamId, {
			fromMembershipId: actor.id,
			toMembershipId: String(body.membershipId ?? ''),
			expectedVersion: typeof body.expectedVersion === 'string' ? body.expectedVersion : undefined,
		});
		if (result.ok) await store.recordAuditEvent({
			actorType: 'user', actorId: access.principal.id, eventType: 'team.ownership.transferred',
			targetType: 'team', targetId: teamId, data: { membershipId: body.membershipId },
		});
		return c.json(result, statusFor(result));
	});

	app.post('/v1/teams/:teamId/leave', async (c: any) => {
		const auth = await ensurePrincipal(c);
		if (auth.response) return auth.response;
		const result = await store.leaveTeam(c.req.param('teamId'), auth.principal.id);
		if (result.ok) await store.recordAuditEvent({
			actorType: 'user', actorId: auth.principal.id, eventType: 'team.member.left',
			targetType: 'team', targetId: c.req.param('teamId'),
		});
		return c.json(result, statusFor(result));
	});
}
