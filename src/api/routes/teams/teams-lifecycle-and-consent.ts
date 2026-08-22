function statusFor(result: { ok?: boolean; code?: string }) {
	if (result.ok) return 200;
	if (result.code === 'missing') return 404;
	if (result.code === 'stale' || result.code === 'stale_or_expired' || result.code === 'invite_already_pending') return 409;
	if (result.code === 'blocked') return 422;
	return 400;
}

export function installTeamsLifecycleAndConsentRoutes(context: any) {
	const { app, config, consumeReauthentication, deleteTeamCapacityAggregate, ensurePrincipal, jsonError, controlPlaneAuthContext, sendTeamInviteEmail, store } = context;

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

}
