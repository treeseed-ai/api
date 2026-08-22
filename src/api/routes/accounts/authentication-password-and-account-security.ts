export function installAuthenticationPasswordAndAccountSecurityRoutes(context: any) {
	const { accountDeletionBlockers, accountDeletionConfirmationMatches, app, config, consumeReauthentication, createHash, deleteTeamCapacityAggregate, ensureControlPlaneCredentialSchema, ensurePrincipal, hashControlPlanePassword, jsonError, controlPlaneAuthContext, normalizeEmail, normalizeUsername, passwordResetUrlFor, randomBytes, randomUUID, readJsonOrFormBody, runtimeControlPlaneAuthProvider, sendAuthEmail, store, validateControlPlanePassword, verifyControlPlanePassword } = context;
	app.patch('/v1/auth/web/password', async (c) => {
					await ensureControlPlaneCredentialSchema(store);
					const auth = await ensurePrincipal(c);
					if (auth.response) return auth.response;
					const body = await readJsonOrFormBody(c);
					const currentPassword = String(body.currentPassword ?? '');
					const newPassword = String(body.newPassword ?? body.password ?? '');
					if (!validateControlPlanePassword(newPassword)) return jsonError(c, 400, 'Password must be at least 12 characters.');
					const row = await store.first(`SELECT password_hash FROM control_plane_auth_credentials WHERE user_id = ? LIMIT 1`, [auth.principal.id]);
					if (!await consumeReauthentication(store, auth.principal, 'password_change', body)) return jsonError(c, 401, 'Reauthentication is required.', { code: 'reauthentication_required' });
					if (!row) {
						const email = normalizeEmail(auth.principal.metadata?.email);
						const username = normalizeUsername(auth.principal.metadata?.username ?? auth.principal.id);
						await store.run(
							`INSERT INTO control_plane_auth_credentials (user_id, email, username, password_hash, status, created_at, updated_at)
							 VALUES (?, ?, ?, ?, 'active', ?, ?)`,
							[auth.principal.id, email || `${auth.principal.id}@treeseed.local`, username || null, hashControlPlanePassword(newPassword), new Date().toISOString(), new Date().toISOString()],
						);
					} else {
						await store.run(`UPDATE control_plane_auth_credentials SET password_hash = ?, updated_at = ? WHERE user_id = ?`, [
							hashControlPlanePassword(newPassword),
							new Date().toISOString(),
							auth.principal.id,
						]);
					}
					return c.json({ ok: true, payload: { changed: true } });
				});
	
	app.post('/v1/auth/web/reauthenticate', async (c) => {
					const auth = await ensurePrincipal(c);
					if (auth.response) return auth.response;
					const body = await readJsonOrFormBody(c);
					const action = ['password_change', 'account_delete'].includes(body.action) ? body.action : null;
					if (!action) return jsonError(c, 400, 'A valid reauthentication action is required.');
					const credential = await store.first(`SELECT password_hash FROM control_plane_auth_credentials WHERE user_id = ? AND status = 'active' LIMIT 1`, [auth.principal.id]);
					if (!credential || !verifyControlPlanePassword(String(body.password ?? ''), credential.password_hash)) return jsonError(c, 401, 'Current password was not accepted.');
					const grantId = randomUUID();
					await store.run(`INSERT INTO auth_reauthentication_grants (id, user_id, session_id, action, expires_at, consumed_at, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?)`, [grantId, auth.principal.id, auth.principal.metadata?.sessionId ?? '', action, new Date(Date.now() + 5 * 60_000).toISOString(), new Date().toISOString()]);
					return c.json({ ok: true, payload: { grantId, action, expiresInSeconds: 300 } });
				});
	
	app.post('/v1/auth/web/password-reset/request', async (c) => {
					await ensureControlPlaneCredentialSchema(store);
					const body = await readJsonOrFormBody(c);
					const email = normalizeEmail(body.email);
					const row = email
						? await store.first(
							`SELECT control_plane_auth_credentials.user_id
							   FROM control_plane_auth_credentials
							   INNER JOIN user_email_addresses
							      ON user_email_addresses.user_id = control_plane_auth_credentials.user_id
							     AND user_email_addresses.normalized_email = ?
							     AND user_email_addresses.status = 'verified'
							  WHERE control_plane_auth_credentials.status = 'active'
							  LIMIT 1`,
							[email],
						)
						: null;
					let resetToken = null;
					if (row) {
						resetToken = `reset_${randomBytes(24).toString('base64url')}`;
						await store.run(
							`INSERT INTO control_plane_auth_password_resets (id, user_id, token_hash, expires_at, used_at, created_at)
							 VALUES (?, ?, ?, ?, NULL, ?)`,
							[
								randomUUID(),
								row.user_id,
								createHash('sha256').update(resetToken).digest('hex'),
								new Date(Date.now() + 60 * 60 * 1000).toISOString(),
								new Date().toISOString(),
							],
						);
						const resetUrl = passwordResetUrlFor(controlPlaneAuthContext(c, config), resetToken);
						try {
							await sendAuthEmail(controlPlaneAuthContext(c, config), {
									to: email,
									subject: 'Reset your TreeSeed password',
									text: [
										'Reset your TreeSeed password:',
										resetUrl,
										'',
										'If you did not request a password reset, you can ignore this email.',
									].join('\n'),
									html: [
										'<div style="font-family:Inter,Arial,sans-serif;line-height:1.5;color:#17211b">',
										'<h1 style="font-size:24px">Reset your TreeSeed password</h1>',
										'<p>Use this secure link to reset your password.</p>',
										`<p><a href="${resetUrl}" style="display:inline-block;background:#2f6f4e;color:white;padding:12px 18px;border-radius:6px;text-decoration:none;font-weight:700">Reset password</a></p>`,
										`<p style="word-break:break-all;color:#526052">${resetUrl}</p>`,
										'<p>If you did not request a password reset, you can ignore this email.</p>',
										'</div>',
									].join(''),
							});
						} catch (error) {
							console.warn('[control-plane-auth] Password reset email failed:', error instanceof Error ? error.message : String(error));
							return jsonError(c, 503, 'Password reset email could not be sent. Please try again shortly.', {
								code: 'password_reset_delivery_failed',
								...(process.env.NODE_ENV === 'test' ? { detail: error instanceof Error ? error.message : String(error) } : {}),
							});
						}
					}
					return c.json({
						ok: true,
						payload: {
							sent: true,
						},
					});
				});
	
	app.post('/v1/auth/web/password-reset/complete', async (c) => {
					await ensureControlPlaneCredentialSchema(store);
					const body = await readJsonOrFormBody(c);
					const token = String(body.token ?? '');
					const newPassword = String(body.newPassword ?? body.password ?? '');
					if (!token || !validateControlPlanePassword(newPassword)) return jsonError(c, 400, 'A valid reset token and password are required.');
					const row = await store.first(
						`SELECT * FROM control_plane_auth_password_resets WHERE token_hash = ? AND used_at IS NULL LIMIT 1`,
						[createHash('sha256').update(token).digest('hex')],
					);
					if (!row || new Date(row.expires_at).getTime() <= Date.now()) return jsonError(c, 401, 'Password reset token is invalid or expired.');
					await store.run(`UPDATE control_plane_auth_credentials SET password_hash = ?, updated_at = ? WHERE user_id = ?`, [
						hashControlPlanePassword(newPassword),
						new Date().toISOString(),
						row.user_id,
					]);
					await store.run(`UPDATE control_plane_auth_password_resets SET used_at = ? WHERE id = ?`, [new Date().toISOString(), row.id]);
					await store.recordAuditEvent({
						actorType: 'user', actorId: row.user_id, eventType: 'auth.password.reset',
						targetType: 'user', targetId: row.user_id,
					});
					return c.json({ ok: true });
				});
	
	app.get('/v1/auth/web/account/deletion-blockers', async (c) => {
					const auth = await ensurePrincipal(c);
					if (auth.response) return auth.response;
					const blockers = await accountDeletionBlockers(store, auth.principal);
					return c.json({ ok: true, payload: { blockers, canDelete: blockers.length === 0 } });
				});
	
	app.delete('/v1/auth/web/account', async (c) => {
					await ensureControlPlaneCredentialSchema(store);
					const auth = await ensurePrincipal(c);
					if (auth.response) return auth.response;
					const body = await readJsonOrFormBody(c);
					if (!accountDeletionConfirmationMatches(String(body.confirmation ?? ''))) {
						return jsonError(c, 409, 'Type "DELETE MY ACCOUNT" to delete this account.', { code: 'confirmation' });
					}
					const blockers = await accountDeletionBlockers(store, auth.principal);
					if (blockers.length) return jsonError(c, 409, 'Account deletion is blocked.', { code: 'deletion_blocked', blockers });
					if (!await consumeReauthentication(store, auth.principal, 'account_delete', body)) return jsonError(c, 401, 'Reauthentication is required.', { code: 'reauthentication_required' });
					const personalTeams = (await store.listTeamsForPrincipal(auth.principal))
						.filter((team) => team.metadata?.kind === 'personal_research' && team.metadata?.ownerUserId === auth.principal.id);
					for (const team of personalTeams) {
						const deletedTeam = await deleteTeamCapacityAggregate(store, team.id, `DELETE ${team.name ?? team.slug}`);
						if (!deletedTeam.ok) return jsonError(c, 409, 'Personal account workspace could not be deleted.', { code: 'personal_team_deletion_failed' });
					}
					const now = new Date().toISOString();
					await store.batch([
						{ query: `UPDATE users SET status = 'deleted', updated_at = ? WHERE id = ?`, params: [now, auth.principal.id] },
						{ query: `UPDATE control_plane_auth_credentials SET email = ?, status = 'deleted', updated_at = ? WHERE user_id = ?`, params: [`deleted+${auth.principal.id}@invalid`, now, auth.principal.id] },
						...['user_email_addresses', 'user_identities', 'auth_reauthentication_grants', 'user_personal_themes', 'user_preferences', 'user_notification_global_content_types', 'user_notification_project_content_types', 'user_notification_project_overrides', 'user_notification_preferences', 'notification_email_deliveries', 'user_notifications'].map((table) => ({ query: `DELETE FROM ${table} WHERE user_id = ?`, params: [auth.principal.id] })),
						{ query: `UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, ?), updated_at = ? WHERE user_id = ?`, params: [now, now, auth.principal.id] },
					]);
					await store.recordAuditEvent({
						actorType: 'user', actorId: auth.principal.id, eventType: 'account.deleted',
						targetType: 'user', targetId: auth.principal.id,
					});
					return c.json({ ok: true, payload: { deleted: true } });
				});
	
	app.post('/v1/auth/token/refresh', async (c) => {
					const body = await c.req.json().catch(() => ({}));
					try {
						return c.json(await runtimeControlPlaneAuthProvider.refreshAccessToken({ refreshToken: String(body.refreshToken ?? '') }));
					} catch (error) {
						return jsonError(c, 401, error instanceof Error ? error.message : String(error));
					}
				});
	
	app.post('/v1/auth/logout', async (c) => {
					const auth = await ensurePrincipal(c);
					if (auth.response) return auth.response;
					const sessionId = auth.principal.metadata?.sessionId;
					if (typeof sessionId === 'string' && sessionId.trim()) {
						await store.run(
							`UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, ?), updated_at = ? WHERE id = ? AND user_id = ?`,
							[new Date().toISOString(), new Date().toISOString(), sessionId, auth.principal.id],
						).catch(() => {});
						await store.recordAuditEvent({
							actorType: 'user', actorId: auth.principal.id, eventType: 'auth.session.revoked',
							targetType: 'auth_session', targetId: sessionId, data: { reason: 'logout' },
						});
					}
					return c.json({ ok: true });
				});
}
