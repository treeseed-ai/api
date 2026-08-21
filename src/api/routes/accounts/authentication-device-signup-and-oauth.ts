export function installAuthenticationDeviceSignupAndOauthRoutes(context: any) {
	const { AUTH_PROVIDERS, CONTROL_PLANE_EMAIL_CONFIRMATION_PREFIX, app, authEmailDeliveryFailureDetail, authEmailDeliveryFailureReason, authTokenTimestampMillis, config, createHash, createControlPlaneEmailConfirmation, createControlPlaneWebSession, ensureControlPlaneCredentialSchema, ensurePrincipal, exchangeProviderIdentity, exposeAuthTokenForTests, hashControlPlanePassword, jsonError, controlPlaneAuthContext, controlPlaneEmailTokenHash, normalizeAppearancePreference, normalizeEmail, normalizeUsername, optionalTrimmedString, providerConfigFor, randomBytes, randomUUID, readJsonOrFormBody, requireConfiguredServiceCredential, resolveAuthApprovalBaseUrl, runtime, runtimeControlPlaneAuthProvider, sanitizedReturnTo, sendWelcomeEmail, setPrimaryEmailAddress, shouldBypassAcceptanceAuthEmailDelivery, shouldExposeNonProductionAuthDiagnostics, store, validateControlPlanePassword, validatePublicUsername, verifiedEmailCount, verifyControlPlanePassword, webAuthPayload, webSessionData } = context;
	app.post('/v1/auth/device/start', async (c) => {
					const body = await c.req.json().catch(() => ({}));
					const started = await runtimeControlPlaneAuthProvider.startDeviceFlow({
						clientName: typeof body.clientName === 'string' ? body.clientName : 'treeseed-cli',
						scopes: Array.isArray(body.scopes) ? body.scopes.map(String) : ['auth:me'],
					});
					return c.json(started);
				});
	
	app.post('/v1/auth/device/poll', async (c) => {
					const body = await c.req.json().catch(() => ({}));
					const response = await runtimeControlPlaneAuthProvider.pollDeviceFlow({ deviceCode: String(body.deviceCode ?? '') });
					return c.json(response, { status: response.ok ? 200 : response.status === 'expired' ? 410 : 400 });
				});
	
	app.get('/v1/auth/device/approve', (c) => {
					const target = new URL('/auth/device/approve', `${resolveAuthApprovalBaseUrl(config)}/`);
					const userCode = c.req.query('user_code');
					if (userCode) target.searchParams.set('user_code', userCode);
					return c.redirect(target.toString(), 302);
				});
	
	app.post('/v1/auth/device/approve', async (c) => {
					const auth = await ensurePrincipal(c);
					if (auth.response) return auth.response;
					const body = await c.req.json().catch(() => ({}));
					try {
						return c.json(await runtimeControlPlaneAuthProvider.approveDeviceFlow({
							userCode: String(body.userCode ?? ''),
							principalId: auth.principal.id,
							displayName: auth.principal.displayName,
							metadata: auth.principal.metadata,
							scopes: Array.isArray(body.scopes) ? body.scopes.map(String) : undefined,
						}));
					} catch (error) {
						return jsonError(c, 400, error instanceof Error ? error.message : String(error));
					}
				});
	
	app.post('/v1/auth/web/sign-up', async (c) => {
					await ensureControlPlaneCredentialSchema(store);
					const body = await readJsonOrFormBody(c);
					const email = normalizeEmail(body.email);
					const username = normalizeUsername(body.username);
					const password = String(body.password ?? '');
					const displayName = String(body.displayName ?? body.name ?? email).trim();
					const returnTo = sanitizedReturnTo(body.returnTo);
					const inviteToken = String(body.inviteToken ?? '').trim();
					const appearance = normalizeAppearancePreference(body.appearance && typeof body.appearance === 'object' ? body.appearance : body);
					const usernameValidation = validatePublicUsername(username);
					if (!email || !email.includes('@')) return jsonError(c, 400, 'A valid email is required.');
					if (!usernameValidation.ok) return jsonError(c, 400, usernameValidation.message);
					if (!validateControlPlanePassword(password)) return jsonError(c, 400, 'Password must be at least 12 characters.');
					const inviteProof = inviteToken ? await store.getPendingTeamInviteByToken(inviteToken) : null;
					if (inviteToken && (!inviteProof?.ok || String(inviteProof.invite?.email ?? '').trim().toLowerCase() !== email)) {
						return jsonError(c, 400, 'Team invite does not match this registration email.', { code: 'invite_email_mismatch' });
					}
					const existingEmailCredential = await store.first(
						`SELECT user_id FROM control_plane_auth_credentials WHERE email = ? LIMIT 1`,
						[email],
					);
					if (existingEmailCredential) return jsonError(c, 409, 'This email can’t be used.', { code: 'email_unavailable' });
					const existingUsernameCredential = await store.first(
						`SELECT user_id FROM control_plane_auth_credentials WHERE username = ? LIMIT 1`,
						[username],
					);
					if (existingUsernameCredential) return jsonError(c, 409, 'Username is already taken.');
					if (await store.publicUsernameExists(username)) return jsonError(c, 409, 'Username is already taken.');
					if (await store.teamPublicNameExists(username)) {
						return jsonError(c, 409, 'Username is already taken by a team.', { code: 'namespace_taken' });
					}
					const existingEmailAddress = await store.first(
						`SELECT user_id FROM user_email_addresses WHERE normalized_email = ? LIMIT 1`,
						[email],
					);
					if (existingEmailAddress) return jsonError(c, 409, 'This email can’t be used.', { code: 'email_unavailable' });
					const synced = await runtimeControlPlaneAuthProvider.syncUserIdentity({
						provider: 'credential',
						providerSubject: email,
						email,
						emailVerified: false,
						username,
						displayName,
						profile: {
							firstName: optionalTrimmedString(body.firstName),
							lastName: optionalTrimmedString(body.lastName),
						},
					});
					await store.run(`UPDATE users SET metadata_json = ?, updated_at = ? WHERE id = ?`, [
						JSON.stringify({
							...(synced.principal.metadata ?? {}),
							appearance,
						}),
						new Date().toISOString(),
						synced.principal.id,
					]).catch(() => null);
					const now = new Date().toISOString();
					await store.run(
						`INSERT INTO control_plane_auth_credentials (user_id, email, username, password_hash, status, created_at, updated_at)
						 VALUES (?, ?, ?, ?, ?, ?, ?)`,
						[synced.principal.id, email, username, hashControlPlanePassword(password), 'pending_email_confirmation', now, now],
					);
					const emailAddressId = randomUUID();
					await store.run(
						`INSERT INTO user_email_addresses (
							id, user_id, email, normalized_email, status, is_primary, verification_requested_at, verified_at, created_at, updated_at
						) VALUES (?, ?, ?, ?, ?, 1, NULL, ?, ?, ?)`,
						[emailAddressId, synced.principal.id, email, email, 'pending', null, now, now],
					);
					let confirmation;
					try {
						confirmation = await createControlPlaneEmailConfirmation(store, controlPlaneAuthContext(c, config), {
							email,
							emailAddressId,
							displayName,
							returnTo,
							skipDelivery: shouldBypassAcceptanceAuthEmailDelivery(c, runtime.resolved.config),
						});
					} catch (error) {
						await store.run(`DELETE FROM control_plane_auth_credentials WHERE user_id = ?`, [synced.principal.id]).catch(() => null);
						await store.run(`DELETE FROM user_email_addresses WHERE user_id = ?`, [synced.principal.id]).catch(() => null);
						await store.run(`DELETE FROM better_auth_verification WHERE identifier = ?`, [`${CONTROL_PLANE_EMAIL_CONFIRMATION_PREFIX}${emailAddressId}`]).catch(() => null);
						console.warn('[control-plane-auth] Email confirmation setup failed:', error instanceof Error ? error.message : String(error));
						const reason = authEmailDeliveryFailureReason(error);
						return jsonError(c, 503, 'Email confirmation could not be sent. Please try again shortly.', {
							code: 'email_confirmation_delivery_failed',
							reason,
							...(shouldExposeNonProductionAuthDiagnostics(c, runtime) ? { detail: authEmailDeliveryFailureDetail(error) } : {}),
						});
					}
					await store.ensureCommonsParticipantForPrincipal(synced.principal, {
						displayName,
						metadata: { registrationSource: 'web_sign_up' },
					}).catch((error) => {
						console.warn('[commons] Participant enrollment after sign-up failed:', error instanceof Error ? error.message : String(error));
					});
					return c.json({
						ok: true,
						payload: {
							confirmationRequired: true,
							email,
							expiresInSeconds: confirmation.expiresInSeconds,
							confirmationToken: exposeAuthTokenForTests(c, runtime.resolved.config) ? confirmation.token : undefined,
						},
					});
				});
	
	app.post('/v1/acceptance/auth/confirm-email', async (c) => {
					const service = requireConfiguredServiceCredential(c, runtime.resolved.config);
					if (service.response) return service.response;
					await ensureControlPlaneCredentialSchema(store);
					const body = await readJsonOrFormBody(c);
					const email = normalizeEmail(body.email);
					if (!email) return jsonError(c, 400, 'Email is required.');
					const emailAddress = await store.first(
						`SELECT * FROM user_email_addresses WHERE normalized_email = ? ORDER BY created_at DESC LIMIT 1`,
						[email],
					);
					if (!emailAddress?.id) return jsonError(c, 404, 'Email confirmation record not found.');
					const credential = await store.first(
						`SELECT user_id, email, username, status FROM control_plane_auth_credentials WHERE user_id = ? LIMIT 1`,
						[emailAddress.user_id],
					);
					if (!credential || credential.status === 'deleted') return jsonError(c, 404, 'Email confirmation record not found.');
					const now = new Date().toISOString();
					const firstVerified = (await verifiedEmailCount(store, emailAddress.user_id)) === 0;
					if (firstVerified) {
						const personalTeam = await store.ensurePersonalResearchTeamForUser(emailAddress.user_id);
						if (!personalTeam.ok) {
							return jsonError(c, personalTeam.code === 'namespace_conflict' ? 409 : 400, personalTeam.message, { code: personalTeam.code });
						}
					}
					await store.run(
						`UPDATE user_email_addresses
						 SET status = 'verified', verified_at = COALESCE(verified_at, ?), updated_at = ?
						 WHERE id = ?`,
						[now, now, emailAddress.id],
					);
					await store.claimSeedTeamMembershipsForVerifiedEmail(emailAddress.user_id, email);
					if (Number(emailAddress.is_primary ?? 0) === 1 || firstVerified) {
						await setPrimaryEmailAddress(store, emailAddress.user_id, emailAddress.id);
					}
					if (credential.status !== 'active') {
						await store.run(
							`UPDATE control_plane_auth_credentials SET status = 'active', updated_at = ? WHERE user_id = ?`,
							[now, credential.user_id],
						);
						await store.run(
							`UPDATE user_identities SET email_verified = 1, updated_at = ? WHERE user_id = ?`,
							[now, credential.user_id],
						).catch(() => null);
					}
					await store.run(`DELETE FROM better_auth_verification WHERE identifier = ?`, [`${CONTROL_PLANE_EMAIL_CONFIRMATION_PREFIX}${emailAddress.id}`]).catch(() => null);
					return c.json({
						ok: true,
						payload: {
							email,
							emailAddressId: emailAddress.id,
							userId: emailAddress.user_id,
							verified: true,
						},
					});
				});
	
	app.post('/v1/auth/web/confirm-email', async (c) => {
					await ensureControlPlaneCredentialSchema(store);
					const body = await readJsonOrFormBody(c);
					const token = String(body.token ?? '').trim();
					if (!token) return jsonError(c, 400, 'Email confirmation token is required.');
					const row = await store.first(
						`SELECT * FROM better_auth_verification WHERE value = ? AND identifier LIKE ? LIMIT 1`,
						[controlPlaneEmailTokenHash(token), `${CONTROL_PLANE_EMAIL_CONFIRMATION_PREFIX}%`],
					);
					const expiresAt = authTokenTimestampMillis(row?.expiresAt ?? row?.expiresat ?? 0);
					if (!row || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
						return jsonError(c, 401, 'Email confirmation token is invalid or expired.');
					}
					const emailAddressId = String(row.identifier ?? '').slice(CONTROL_PLANE_EMAIL_CONFIRMATION_PREFIX.length);
					const emailAddress = await store.first(`SELECT * FROM user_email_addresses WHERE id = ? LIMIT 1`, [emailAddressId]);
					if (!emailAddress?.id) {
						return jsonError(c, 401, 'Email confirmation token is invalid or expired.');
					}
					const email = String(emailAddress.email ?? '').trim().toLowerCase();
					const credential = await store.first(
						`SELECT user_id, email, username, status FROM control_plane_auth_credentials WHERE user_id = ? LIMIT 1`,
						[emailAddress.user_id],
					);
					if (!credential || credential.status === 'deleted') {
						return jsonError(c, 401, 'Email confirmation token is invalid or expired.');
					}
					const now = new Date().toISOString();
					const firstVerified = (await verifiedEmailCount(store, emailAddress.user_id)) === 0;
					if (firstVerified) {
						const personalTeam = await store.ensurePersonalResearchTeamForUser(emailAddress.user_id);
						if (!personalTeam.ok) {
							return jsonError(c, personalTeam.code === 'namespace_conflict' ? 409 : 400, personalTeam.message, { code: personalTeam.code });
						}
					}
					await store.run(
						`UPDATE user_email_addresses
						 SET status = 'verified', verified_at = COALESCE(verified_at, ?), updated_at = ?
						 WHERE id = ?`,
						[now, now, emailAddress.id],
					);
					await store.claimSeedTeamMembershipsForVerifiedEmail(emailAddress.user_id, email);
					if (Number(emailAddress.is_primary ?? 0) === 1 || firstVerified) {
						await setPrimaryEmailAddress(store, emailAddress.user_id, emailAddress.id);
					}
					if (credential.status !== 'active') {
						await store.run(
							`UPDATE control_plane_auth_credentials SET status = 'active', updated_at = ? WHERE user_id = ?`,
							[now, credential.user_id],
						);
						await store.run(
							`UPDATE user_identities SET email_verified = 1, updated_at = ? WHERE user_id = ? AND provider = 'credential'`,
							[now, credential.user_id],
						).catch(() => null);
					}
					await store.run(`DELETE FROM better_auth_verification WHERE id = ?`, [row.id]).catch(() => null);
					const session = await createControlPlaneWebSession(runtimeControlPlaneAuthProvider, emailAddress.user_id, webSessionData(c, 'web_email_confirmed'), { store, authSecret: runtime.resolved.config.authSecret });
					await store.recordAuditEvent({
						actorType: 'user', actorId: emailAddress.user_id, eventType: 'auth.email.verified',
						targetType: 'user', targetId: emailAddress.user_id, data: { emailAddressId: emailAddress.id },
					});
					if (credential.status !== 'active') {
						await sendWelcomeEmail(controlPlaneAuthContext(c, config), {
							email,
							displayName: credential.username ?? email,
						}).catch((error) => {
							console.info(`[auth-email] Welcome email skipped after confirmation: ${error instanceof Error ? error.message : String(error)}`);
						});
					}
					return c.json({ ok: true, payload: webAuthPayload(session) });
				});
	
	app.post('/v1/auth/web/sign-in', async (c) => {
					await ensureControlPlaneCredentialSchema(store);
					const body = await readJsonOrFormBody(c);
					const identifier = normalizeEmail(body.email ?? body.login ?? body.username);
					const password = String(body.password ?? '');
					if (!identifier || !password) return jsonError(c, 400, 'Email or username and password are required.');
					let row = await store.first(
						`SELECT control_plane_auth_credentials.user_id, control_plane_auth_credentials.password_hash, control_plane_auth_credentials.status
						   FROM control_plane_auth_credentials
						   LEFT JOIN user_email_addresses
						     ON user_email_addresses.user_id = control_plane_auth_credentials.user_id
						    AND user_email_addresses.normalized_email = ?
						    AND user_email_addresses.status = 'verified'
						  WHERE control_plane_auth_credentials.username = ?
						     OR user_email_addresses.id IS NOT NULL
						  LIMIT 1`,
						[identifier, identifier],
					);
					if (!row) {
						row = await store.first(
							`SELECT control_plane_auth_credentials.user_id, control_plane_auth_credentials.password_hash, control_plane_auth_credentials.status, user_email_addresses.status AS email_status
							   FROM control_plane_auth_credentials
							   INNER JOIN user_email_addresses
							      ON user_email_addresses.user_id = control_plane_auth_credentials.user_id
							     AND user_email_addresses.normalized_email = ?
							  LIMIT 1`,
							[identifier],
						);
					}
					if (!row || row.status === 'deleted' || !verifyControlPlanePassword(password, row.password_hash)) {
						return jsonError(c, 401, 'Authentication failed.');
					}
					if (row.status !== 'active' || (row.email_status && row.email_status !== 'verified')) {
						return jsonError(c, 403, 'Email confirmation is required before signing in.', {
							code: 'email_confirmation_required',
						});
					}
						const session = await createControlPlaneWebSession(runtimeControlPlaneAuthProvider, row.user_id, webSessionData(c, 'web_sign_in'), { store, authSecret: runtime.resolved.config.authSecret });
					return c.json({ ok: true, payload: webAuthPayload(session) });
				});
	
	app.get('/v1/auth/providers', (c) => {
					const payload = Object.entries(AUTH_PROVIDERS)
						.filter(([provider]) => Boolean(providerConfigFor(c, provider)))
							.map(([id, provider]) => ({ id, label: (provider as { label: string }).label }));
					return c.json({ ok: true, payload });
				});
	
	app.get('/v1/auth/oauth/:provider/start', async (c) => {
					const provider = c.req.param('provider');
					const configured = providerConfigFor(c, provider);
					if (!configured) return jsonError(c, 404, 'The requested identity provider is unavailable.');
					const purpose = ['link', 'reauthenticate'].includes(c.req.query('purpose')) ? c.req.query('purpose') : 'sign-in';
					const auth = purpose === 'sign-in' ? null : await ensurePrincipal(c);
					if (auth?.response) return auth.response;
					const state = randomBytes(32).toString('base64url');
					const verifier = randomBytes(48).toString('base64url');
					const challenge = createHash('sha256').update(verifier).digest('base64url');
					const callbackUrl = String(c.req.query('callbackUrl') ?? `${resolveAuthApprovalBaseUrl(config)}/auth/callback/${provider}`);
					const returnTo = sanitizedReturnTo(c.req.query('returnTo'));
					const now = new Date();
					const nonce = randomBytes(24).toString('base64url');
					await store.run(
						`INSERT INTO auth_provider_states (id, provider, state_hash, code_verifier, nonce, callback_url, return_to, link_user_id, purpose, action, expires_at, used_at, created_at)
						 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
						[randomUUID(), provider, createHash('sha256').update(state).digest('hex'), verifier, nonce, callbackUrl, returnTo, auth?.principal?.id ?? null, purpose, c.req.query('action') ?? null, new Date(now.getTime() + 10 * 60_000).toISOString(), now.toISOString()],
					);
					const target = new URL(configured.authorizeUrl);
					target.searchParams.set('client_id', configured.clientId);
					target.searchParams.set('redirect_uri', callbackUrl);
					target.searchParams.set('response_type', 'code');
					target.searchParams.set('scope', configured.scopes);
					target.searchParams.set('state', state);
					target.searchParams.set('code_challenge', challenge);
					target.searchParams.set('code_challenge_method', 'S256');
					if (provider !== 'github') target.searchParams.set('nonce', nonce);
					if (provider === 'apple') target.searchParams.set('response_mode', 'form_post');
					return c.redirect(target.toString(), 302);
				});
	
	app.on(['GET', 'POST'], '/v1/auth/oauth/:provider/callback', async (c) => {
					const provider = c.req.param('provider');
					const configured = providerConfigFor(c, provider);
					if (!configured) return jsonError(c, 404, 'The requested identity provider is unavailable.');
					const callbackBody = c.req.method === 'POST' ? await readJsonOrFormBody(c) : {};
					const state = String(c.req.query('state') ?? callbackBody.state ?? '');
					const code = String(c.req.query('code') ?? callbackBody.code ?? '');
					const row = await store.first(`SELECT * FROM auth_provider_states WHERE provider = ? AND state_hash = ? AND used_at IS NULL LIMIT 1`, [provider, createHash('sha256').update(state).digest('hex')]);
					if (!row || !code || new Date(row.expires_at).getTime() <= Date.now()) return jsonError(c, 401, 'The provider sign-in request is invalid or expired.');
					await store.run(`UPDATE auth_provider_states SET used_at = ? WHERE id = ? AND used_at IS NULL`, [new Date().toISOString(), row.id]);
					try {
						const identity = await exchangeProviderIdentity(provider, configured, code, row.callback_url, row.code_verifier, row.nonce);
						if (!identity.subject || !identity.emailVerified || !identity.email) return jsonError(c, 409, 'A verified provider email is required.');
						const existingIdentity = await store.first(`SELECT user_id FROM user_identities WHERE provider = ? AND provider_subject = ? LIMIT 1`, [provider, identity.subject]);
						const normalizedProviderEmail = normalizeEmail(identity.email);
						const existingEmail = await store.first(`SELECT user_id FROM user_email_addresses WHERE normalized_email = ? LIMIT 1`, [normalizedProviderEmail])
							?? await store.first(`SELECT id AS user_id FROM users WHERE LOWER(email) = LOWER(?) LIMIT 1`, [normalizedProviderEmail]);
						if (existingIdentity && row.link_user_id && existingIdentity.user_id !== row.link_user_id) return jsonError(c, 409, 'The provider identity belongs to another account.');
						if (!existingIdentity && !row.link_user_id && existingEmail) return jsonError(c, 409, 'Sign in to the existing account before linking this provider.');
						let userId = existingIdentity?.user_id ?? row.link_user_id ?? null;
						if (!existingIdentity && row.link_user_id) {
							const now = new Date().toISOString();
							await store.run(`INSERT INTO user_identities (id, user_id, provider, provider_subject, email, email_verified, profile_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`, [randomUUID(), row.link_user_id, provider, identity.subject, normalizedProviderEmail, JSON.stringify(identity.profile ?? {}), now, now]);
						} else if (!userId) {
							const synced = await runtimeControlPlaneAuthProvider.syncUserIdentity({ provider, providerSubject: identity.subject, email: normalizedProviderEmail, emailVerified: true, displayName: identity.displayName, profile: identity.profile ?? {} });
							userId = synced.principal.id;
						}
						const session = await createControlPlaneWebSession(runtimeControlPlaneAuthProvider, userId, webSessionData(c, `oauth_${provider}`), { store, authSecret: runtime.resolved.config.authSecret });
						if (row.purpose === 'reauthenticate') {
							const grantId = randomUUID();
							await store.run(`INSERT INTO auth_reauthentication_grants (id, user_id, session_id, action, expires_at, consumed_at, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?)`, [grantId, userId, session.principal.metadata?.sessionId ?? '', row.action ?? 'account_delete', new Date(Date.now() + 5 * 60_000).toISOString(), new Date().toISOString()]);
							return c.json({ ok: true, payload: { ...webAuthPayload(session), returnTo: `${row.return_to}${row.return_to.includes('?') ? '&' : '?'}reauthenticationGrantId=${encodeURIComponent(grantId)}` } });
						}
						const username = normalizeUsername(session.principal.metadata?.username);
						return c.json({ ok: true, payload: { ...webAuthPayload(session), returnTo: username ? row.return_to : `/auth/username?returnTo=${encodeURIComponent(row.return_to)}` } });
					} catch (error) {
						return jsonError(c, 401, error instanceof Error ? error.message : 'Provider sign-in failed.');
					}
				});
}
