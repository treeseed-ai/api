export function installAuthenticationAuthAvailabilityUsernameThroughAuthWebNotificationsItemReadRoutes(context: any) {
	const { AGENT_PROMOTION_APPROVAL_DECISIONS, AGENT_TASK_SIGNATURES, AUTH_PROVIDERS, AgentSdk, CHECKOUT_COMMERCIAL_OFFER_MODES, CHECKOUT_OFFER_MODES, CHECKOUT_SUBSCRIPTION_OFFER_MODES, DatabaseAuthProvider, FEEDBACK_SCREENSHOT_TYPES, FEEDBACK_TYPES, GITHUB_ACTIONS_OIDC_ISSUER, HOST_KIND_SESSION_KEYS, LOCAL_CONTENT_COLLECTIONS, LOCAL_CONTENT_DEFAULTS, LOCAL_DECISION_TYPE_VALUES, LOCAL_WORK_CONTENT_COLLECTIONS, MARKET_EMAIL_CONFIRMATION_PREFIX, MAX_FEEDBACK_MESSAGE_LENGTH, MAX_FEEDBACK_SCREENSHOT_BYTES, MarketControlPlaneStore, NOTIFICATION_CONTENT_CAPABILITIES, PERSONAL_THEME_COMPILER_VERSION, PLAINTEXT_HOST_CREDENTIAL_FIELD_NAMES, PLATFORM_OPERATION_SCOPES, POSTGRES_AUTH_PROVIDER_ID, PROPOSAL_VERDICT_DECISION_TYPES, RemoteTreeseedClient, RemoteTreeseedOperationsClient, RemoteTreeseedSdkClient, SENSITIVE_QUERY_PARAM_PATTERN, STRIPE_PRICE_MIRROR_OFFER_MODES, STRIPE_PRODUCT_MIRROR_OFFER_MODES, TreeseedOperationsSdk, accountDeletionBlockers, accountDeletionConfirmationMatches, addRelationValue, apiDatabaseUrl, app, appendLaunchDeploymentEvent, appendLaunchPhaseProjection, appendProjectDeletionProgress, applyCommerceRefundState, applyContentPublishResult, applyHubLaunchFailure, applyHubLaunchResult, applySeedWithStore, artifactDownloadPayload, authConfig, authEmailDeliveryFailureDetail, authEmailDeliveryFailureReason, authProviderId, authTokenTimestampMillis, authTokenTimestampSeconds, availabilityAttempts, availabilityRateLimit, backfillUserEmailAddresses, base64Url, base64urlJson, bearerTokenFromRequest, buildCommerceCheckoutMetadata, buildCommerceStripeMetadata, buildGovernanceApprovalProjection, buildGovernanceProjection, buildInfrastructureProjection, buildKnowledgeArtifactProjection, buildKnowledgeProjection, buildLaunchCredentialOverlay, buildWorkdayProjection, canSkipCloudflareCleanupAfterFailedLaunch, canonicalArchitectureTopology, capacity, centralMarketProfile, checkoutGroupKey, checkoutGroupKind, checkoutGroupStatus, ciOperationForAction, cleanFeedbackString, cloudflareDeletionAuthenticationMessage, cloudflareDnsDomainsForHostValidation, cloudflareErrorMessage, cloudflareProjectDeletionResourceNames, cloudflareRequestForLaunchPreflight, cloudflareRequestForProjectDeletion, collectHostingAuditCredentialOverlay, commerceCheckoutError, commerceErrorResponse, commerceStripeLookupKey, commerceStripePriceParams, commerceStripeProductParams, commerceStripeSyncContext, config, configuredAuthProviderId, confirmationUrlFor, consumeReauthentication, contentRelationPolicy, createApiApp, createApiExtension, createCapacityControlPlane, createCipheriv, createClientEncryptedEscrowService, createCommerceCheckoutRun, createCommerceCheckoutRunForServiceContract, createDecipheriv, createDecisionFromProposals, createGitHubActionsSecretEnclave, createGitHubAppAdapter, createHash, createHmac, createMarketEmailConfirmation, createMarketPostgresDatabase, createMarketWebSession, createOrResendUserEmailAddress, createProjectHostCredentialSessions, createProjectInternalClient, createPublicKey, createRelatedLocalContentRecord, createStripeConnectService, createTreeDxCredentialBridge, createTreeseedApiApp, createVerify, credentialSessionKey, credentialSessionSecret, db, decodeRouteParam, decorateJob, decoratePlatformOperation, decryptCredentialSessionPayload, decryptHostConfig, decryptTeamHostForLaunch, decryptedHostConfigSummary, defaultConfig, deleteCloudflareDnsRecordsForProject, deleteCloudflareProjectResources, deleteTeamCapacityAggregate, derivePlatformOperationNavigation, deriveProjectHostBindingsView, domainInZone, encryptCredentialSessionPayload, encryptedHostPayloadLooksValid, enqueueTreeDxProvisionOperation, ensureCommerceStripeCustomer, ensureMarketCredentialSchema, ensurePrincipal, entitlementRenewalStateFromSubscription, enumValue, exchangeProviderIdentity, executeInline, executeProjectApi, executeSdkOperation, existsSync, exportSeedWithStore, exposeAuthTokenForTests, fallbackRemoteCapability, findById, findDispatchCapability, getSiteAuthConfig, getUserEmailAddress, githubOidcJwksCache, githubRequestForProjectDeletion, grantCommerceEntitlementsForOrder, handleCommerceInvoiceWebhook, handleCommercePaymentIntentWebhook, handleCommerceSubscriptionWebhook, hasRecordedCloudflareRuntimeResources, hashMarketPassword, hostBindingRequiresUnlock, hostKindForBinding, hubRepositoryPolicies, inferZoneNameForDomain, installApiRequestLogger, installCapacityRoutes, installProjectDeploymentRoutes, isLocalAcceptanceServicePrincipal, isLoopbackUrl, isPlatformOperationTerminal, isTeamApiPrincipal, isValidPersonalThemeDraft, jsonError, jsonThrownError, launchCapabilityPreset, launchPlannerRepositoryTopology, listCloudflareNamedResources, listTreeseedManagedHostsFromConfig, listUserEmailAddresses, loadGitHubOidcJwks, loadInfrastructureSeedState, loadKnowledgeContentEntries, loadNotificationPreferences, loadProjectHostBindingContext, loadTemplateCatalog, localAcceptanceAdminToken, localAcceptanceAuthEnabled, localContentPath, localContentRoot, logRequests, managedCloudflareConfigMissing, markdownToPlainProjectSummary, marketAuthContext, marketEmailTokenHash, marketProfilesForTeams, mergeCapability, mergeStringConfig, mkdir, nonSecretLaunchJobInput, normalizeAppearancePreference, normalizeAuditHostKinds, normalizeBaseUrl, normalizeCheckoutQuantity, normalizeCiEnvironment, normalizeDomainName, normalizeEmail, normalizeLocalContentInput, normalizeMarketProfile, normalizeNotificationPreferences, normalizeProjectDomainInput, normalizeProjectLaunchHostBindings, normalizeProviderCredentialConfig, normalizeRelationArray, normalizeRepositoryContentInput, normalizeRepositoryRelationArray, normalizeRepositorySlug, normalizeSeedEnvironments, normalizeTemplateLaunchRequirements, normalizeTreeseedTemplateId, normalizeUsername, normalizedCloudflareKvNamespaceReference, operationTokenSecret, optionalTrimmedString, orderStatusFromPaymentGroup, parseBase64urlJson, parseBooleanEnvValue, parseJsonObject, parseYaml, passwordResetUrlFor, patchLaunchIntentForCredentialOverlay, paymentGroupStatusFromPaymentIntent, pbkdf2Sync, persistProjectHostBindingOperationMetadata, personalThemeFromRow, plaintextHostCredentialFieldPaths, planKnowledgeHubLaunch, planProjectHostBindingOperation, planSeedWithStore, platformOperationMutationError, principalCanManageCommerceProduct, principalHasGlobalPlatformRole, principalHasPermission, principalIsSeedAdmin, privateKnowledgeAuditPayload, processCommerceStripeWebhook, projectAllowedCiRepositories, projectApiConnection, projectAppHref, projectDeletionBlockerRows, projectDeletionConfirmationMatches, projectDeletionHostname, projectDeletionOperation, projectHostBindingMetadata, projectHostResponsePayload, providerConfigFor, providerCredentialValuesForAudit, providerJwksCache, publicPaymentGroups, randomBytes, randomUUID, readCapacityRequestObject, readFile, readJsonOrFormBody, readLocalContentRecord, recordContentNotificationEvent, recordFeedbackSubmission, recordPrivateKnowledgeAudit, redactCommerceOwnershipWorkflow, redactCommerceServiceRequestForBuyer, redactedRequestTarget, refreshCommercePaymentGroupState, refreshCommerceStripeAccount, rejectPlaintextHostCredentialFields, rejectProjectSecretUnlockMaterial, relative, remainingRefundableAmount, repositoryContentRelationPolicy, repositoryInventoryWithPlatform, requestClientIp, requestSessionMetadata, requireCatalogItemAccess, requireCommerceCapacityInquiryAccess, requireCommerceCapacityListingAccess, requireCommerceOfferAccess, requireCommerceProductAccess, requireCommerceVendorForStripe, requireConfiguredServiceCredential, requireConnectedProjectRuntime, requirePlatformRunner, requireProjectAccess, requireProjectRunner, requireSeedApplyAccess, requireSeedPlanAccess, requireSellerTeamAccess, requireServiceBuyerAccess, requireServiceParticipantAccess, requireServiceSellerAccess, requireTeamAccess, requireVendorOrderManager, resolve, resolveAgentArtifactBucket, resolveAgentTaskSignature, resolveApiConfig, resolveAuthApprovalBaseUrl, resolveCloudflareZoneForLaunchPreflight, resolveCommerceCheckoutItem, resolveFulfillmentArtifact, resolveLaunchTemplateRequirements, resolveOrderItemForRefund, resolvePlatformRepositoryDescriptor, resolvePlatformRunnerSecret, resolveProjectDeletionCloudflareZone, resolveProjectLaunchHostBindings, resolvePublicTreeDxTeam, resolveStripeEnvironment, resolveStripePublishableKey, resolveStripeWebhookSecret, resolveTreeseedManagedCloudflareHostConfigFromConfig, resolveUiProjectionContext, resourceRowsFromLaunch, retryApiLaunchBootstrapFromRequest, rm, runProjectDeletionApiDestroy, runProjectLaunchApiBootstrap, runTreeseedHostingAudit, runtime, runtimeMarketAuthProvider, runtimeProviders, safeFeedbackClient, safeFeedbackContext, safeFeedbackScreenshot, safePlatformOperationOutput, safePrivateKnowledgeSlug, safeTokenEquals, sanitizeLaunchResultForStorage, sanitizedReturnTo, scheduleBackgroundBootstrap, seedActor, seedCreatesMissingTeams, seedExistingTeamIds, selectDispatchTarget, sendAuthEmail, sendEmailConfirmation, sendTeamInviteEmail, sendWelcomeEmail, serializeFrontmatter, serializeUserEmailAddress, setPrimaryEmailAddress, sharedSdk, shouldBypassAcceptanceAuthEmailDelivery, shouldExposeNonProductionAuthDiagnostics, shouldLogApiRequests, signEditorialPreviewToken, signOperationToken, slugifyContent, slugifyRepositoryContent, sourceFromProjectDetails, store, stripeAccountMissingError, stripeAccountToConnectedAccountPatch, stripeClientSecret, stripeCommerceUrl, stripeConfiguredError, stripeConnectService, stripeMetadataValue, stripePriceTermsDrift, stripeRefundStatus, stripeTimestampToIso, stripeVendorApprovalError, subscriptionClientSecret, subscriptionStatusFromStripe, syncCommerceOfferStripeProduct, syncCommercePriceStripePrice, syncCommerceSubscriptionFromStripe, syncPrimaryEmailCaches, teamInviteAcceptUrlFor, timingSafeEqual, trimmedHeaderValue, uiRuntimeLocals, uniqueCloudflareKvNamespaceReferences, uniqueRelationArray, unknownKeys, unwrapLaunchOperationOutput, unwrapOperationPayload, updateCheckoutCompletionFromGroup, updateLaunchDeployments, validateCiRefForEnvironment, validateFeedbackAccess, validateMarketPassword, validateProjectSlug, validatePublicUsername, validateTeamHostCredentialPayload, verifiedEmailCount, verifyCloudflareDnsWriteForLaunch, verifyGitHubOidcToken, verifyMarketPassword, verifyOperationToken, verifyProviderIdToken, webAuthPayload, webSessionData, writeFile, writeLocalContentRecord, writeParsedLocalContentRecord, yamlLines, yamlScalar } = context;
	app.get('/v1/auth/availability/username', async (c) => {
					await ensureMarketCredentialSchema(store);
					const username = normalizeUsername(c.req.query('value'));
					const retryAfterSeconds = availabilityRateLimit(c, 'username', username);
					c.header('Cache-Control', 'no-store');
					if (retryAfterSeconds) return c.json({ ok: true, payload: { value: username, available: false, status: 'throttled', message: 'Please wait before checking again.', retryAfterSeconds } });
					const validation = validatePublicUsername(username);
					if (!validation.ok) {
						return c.json({
							ok: true,
							payload: {
								value: username,
								available: false,
								status: validation.code === 'missing' ? 'empty' : validation.code,
								message: validation.code === 'missing' ? 'Username is public and cannot be changed after registration.' : validation.message,
							},
						});
					}
					const row = await store.first(`SELECT user_id FROM market_auth_credentials WHERE username = ? LIMIT 1`, [username]);
					const userTaken = row ? true : await store.publicUsernameExists(username);
					const teamTaken = userTaken ? false : await store.teamPublicNameExists(username);
					return c.json({
						ok: true,
						payload: {
							value: username,
							available: !userTaken && !teamTaken,
							status: userTaken || teamTaken ? 'taken' : 'available',
							message: userTaken ? 'Username is already taken.' : teamTaken ? 'Username is already taken by a team.' : 'Username is available.',
						},
					});
				});
	
	app.get('/v1/auth/availability/email', async (c) => {
					await ensureMarketCredentialSchema(store);
					const email = normalizeEmail(c.req.query('value'));
					const retryAfterSeconds = availabilityRateLimit(c, 'email', email);
					c.header('Cache-Control', 'no-store');
					if (retryAfterSeconds) return c.json({ ok: true, payload: { value: email, available: false, status: 'throttled', message: 'Please wait before checking again.', retryAfterSeconds } });
					if (!email || !email.includes('@')) return c.json({ ok: true, payload: { value: email, available: false, status: 'invalid', message: 'Enter a valid email address.' } });
					const existing = await store.first(`SELECT user_id FROM user_email_addresses WHERE normalized_email = ? LIMIT 1`, [email])
						?? await store.first(`SELECT user_id FROM market_auth_credentials WHERE email = ? LIMIT 1`, [email]);
					return c.json({ ok: true, payload: { value: email, available: !existing, status: existing ? 'taken' : 'available', message: existing ? 'This email can’t be used.' : 'Email is available.' } });
				});
	
	app.get('/v1/auth/web/emails', async (c) => {
					await ensureMarketCredentialSchema(store);
					const auth = await ensurePrincipal(c);
					if (auth.response) return auth.response;
					return c.json({ ok: true, payload: await listUserEmailAddresses(store, auth.principal.id) });
				});
	
	app.get('/v1/auth/web/account/identity', async (c) => {
					await ensureMarketCredentialSchema(store);
					const auth = await ensurePrincipal(c);
					if (auth.response) return auth.response;
					const user = await store.first(`SELECT id, username, display_name, metadata_json FROM users WHERE id = ? LIMIT 1`, [auth.principal.id]);
					const credential = await store.first(`SELECT user_id FROM market_auth_credentials WHERE user_id = ? AND status = 'active' LIMIT 1`, [auth.principal.id]);
					const identities = await store.all(`SELECT id, provider, email, created_at FROM user_identities WHERE user_id = ? AND provider <> 'credential' ORDER BY created_at`, [auth.principal.id]);
					const metadata = parseJsonObject(user?.metadata_json);
					const usableMethods = identities.length + (credential ? 1 : 0);
					return c.json({ ok: true, payload: {
						id: auth.principal.id,
						username: normalizeUsername(user?.username ?? metadata.username),
						displayName: user?.display_name ?? auth.principal.displayName ?? '',
						firstName: metadata.firstName ?? null,
						lastName: metadata.lastName ?? null,
						image: metadata.image ?? null,
						hasCredential: Boolean(credential),
						emails: await listUserEmailAddresses(store, auth.principal.id),
						providers: identities.map((identity) => ({ id: identity.id, provider: identity.provider, email: identity.email, linkedAt: identity.created_at, canUnlink: usableMethods > 1 })),
					} });
				});
	
	app.patch('/v1/auth/web/username', async (c) => {
					const auth = await ensurePrincipal(c);
					if (auth.response) return auth.response;
					const current = await store.first(`SELECT username FROM users WHERE id = ? LIMIT 1`, [auth.principal.id]);
					if (normalizeUsername(current?.username ?? auth.principal.metadata?.username)) return jsonError(c, 409, 'Username is permanent and has already been assigned.', { code: 'username_immutable' });
					const body = await readJsonOrFormBody(c);
					const username = normalizeUsername(body.username);
					const validation = validatePublicUsername(username);
					if (!validation.ok) return jsonError(c, 400, validation.message, { code: validation.code });
					if (await store.publicUsernameExists(username) || await store.teamPublicNameExists(username)) return jsonError(c, 409, 'Username is already taken.', { code: 'username_taken' });
					const metadata = { ...(auth.principal.metadata ?? {}), username };
					try {
						await store.run(`UPDATE users SET username = ?, metadata_json = ?, updated_at = ? WHERE id = ? AND (username IS NULL OR username = '')`, [username, JSON.stringify(metadata), new Date().toISOString(), auth.principal.id]);
					} catch {
						return jsonError(c, 409, 'Username is already taken.', { code: 'username_taken' });
					}
					const session = await createMarketWebSession(runtimeMarketAuthProvider, auth.principal.id, webSessionData(c, 'username_claim'), { store, authSecret: runtime.resolved.config.authSecret });
					return c.json({ ok: true, payload: { ...webAuthPayload(session), username } });
				});
	
	app.delete('/v1/auth/web/providers/:identityId', async (c) => {
					const auth = await ensurePrincipal(c);
					if (auth.response) return auth.response;
					const identity = await store.first(`SELECT * FROM user_identities WHERE id = ? AND user_id = ? LIMIT 1`, [c.req.param('identityId'), auth.principal.id]);
					if (!identity) return jsonError(c, 404, 'Connected identity was not found.');
					const credential = await store.first(`SELECT user_id FROM market_auth_credentials WHERE user_id = ? AND status = 'active' LIMIT 1`, [auth.principal.id]);
					const identityCount = await store.first(`SELECT COUNT(*) AS count FROM user_identities WHERE user_id = ?`, [auth.principal.id]);
					if (!credential && Number(identityCount?.count ?? 0) <= 1) return jsonError(c, 409, 'Keep at least one sign-in method connected.', { code: 'last_authentication_method' });
					await store.run(`DELETE FROM user_identities WHERE id = ? AND user_id = ?`, [identity.id, auth.principal.id]);
					return c.json({ ok: true, payload: { id: identity.id, unlinked: true } });
				});
	
	app.post('/v1/auth/web/emails', async (c) => {
					await ensureMarketCredentialSchema(store);
					const auth = await ensurePrincipal(c);
					if (auth.response) return auth.response;
					const body = await readJsonOrFormBody(c);
					try {
						const result = await createOrResendUserEmailAddress(store, marketAuthContext(c), auth.principal.id, {
							email: body.email,
							displayName: auth.principal.displayName,
							returnTo: '/app/account',
							skipDelivery: shouldBypassAcceptanceAuthEmailDelivery(c, runtime.resolved.config),
						});
						if (!result.ok) return jsonError(c, result.status, result.error);
						return c.json({ ok: true, payload: result });
					} catch (error) {
						console.warn('[market-auth] Email verification setup failed:', error instanceof Error ? error.message : String(error));
						return jsonError(c, 503, 'Email verification could not be sent. Please try again shortly.', {
							code: 'email_verification_delivery_failed',
						});
					}
				});
	
	app.post('/v1/auth/web/emails/:emailId/verify', async (c) => {
					await ensureMarketCredentialSchema(store);
					const auth = await ensurePrincipal(c);
					if (auth.response) return auth.response;
					const row = await getUserEmailAddress(store, auth.principal.id, c.req.param('emailId'));
					if (!row) return jsonError(c, 404, 'Email address was not found.');
					if (row.status === 'verified') {
						return c.json({ ok: true, payload: { emailAddress: row, verificationSent: false } });
					}
					try {
						const confirmation = await createMarketEmailConfirmation(store, marketAuthContext(c), {
							email: row.email,
							emailAddressId: row.id,
							displayName: auth.principal.displayName,
							returnTo: '/app/account',
							skipDelivery: shouldBypassAcceptanceAuthEmailDelivery(c, runtime.resolved.config),
						});
						return c.json({
							ok: true,
							payload: {
								emailAddress: serializeUserEmailAddress(await getUserEmailAddress(store, auth.principal.id, row.id)),
								verificationSent: true,
								confirmationToken: exposeAuthTokenForTests() ? confirmation.token : undefined,
							},
						});
					} catch (error) {
						console.warn('[market-auth] Email verification setup failed:', error instanceof Error ? error.message : String(error));
						return jsonError(c, 503, 'Email verification could not be sent. Please try again shortly.', {
							code: 'email_verification_delivery_failed',
						});
					}
				});
	
	app.post('/v1/auth/web/emails/:emailId/primary', async (c) => {
					await ensureMarketCredentialSchema(store);
					const auth = await ensurePrincipal(c);
					if (auth.response) return auth.response;
					const result = await setPrimaryEmailAddress(store, auth.principal.id, c.req.param('emailId'));
					if (!result.ok) return jsonError(c, result.status, result.error);
					const session = await createMarketWebSession(runtimeMarketAuthProvider, auth.principal.id, webSessionData(c, 'email_primary_update'), { store, authSecret: runtime.resolved.config.authSecret });
					return c.json({ ok: true, payload: { ...webAuthPayload(session), emailAddress: result.emailAddress } });
				});
	
	app.delete('/v1/auth/web/emails/:emailId', async (c) => {
					await ensureMarketCredentialSchema(store);
					const auth = await ensurePrincipal(c);
					if (auth.response) return auth.response;
					const row = await getUserEmailAddress(store, auth.principal.id, c.req.param('emailId'));
					if (!row) return jsonError(c, 404, 'Email address was not found.');
					if (row.status === 'verified' && await verifiedEmailCount(store, auth.principal.id) <= 1) {
						return jsonError(c, 409, 'At least one verified email is required.', { code: 'last_verified_email' });
					}
					await store.run(`DELETE FROM user_email_addresses WHERE id = ? AND user_id = ?`, [row.id, auth.principal.id]);
					if (row.status === 'verified' && row.isPrimary) {
						await syncPrimaryEmailCaches(store, auth.principal.id);
					}
					return c.json({ ok: true, payload: await listUserEmailAddresses(store, auth.principal.id) });
				});
	
	app.get('/v1/auth/web/sessions', async (c) => {
					const auth = await ensurePrincipal(c);
					if (auth.response) return auth.response;
					const sessions = await store.all(
						`SELECT id, session_type, expires_at, revoked_at, data_json, created_at, updated_at
						 FROM auth_sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT 50`,
						[auth.principal.id],
					).catch(() => []);
					return c.json({
						ok: true,
						payload: sessions.map((session) => {
							const data = parseJsonObject(session.data_json);
							return {
								id: session.id,
								provider: session.session_type,
								expiresAt: session.expires_at,
								revokedAt: session.revoked_at,
								authenticatedAt: session.created_at,
								lastSeenAt: session.updated_at,
								ipAddress: typeof data.ipAddress === 'string' ? data.ipAddress : null,
								userAgent: typeof data.userAgent === 'string' ? data.userAgent : null,
								current: auth.principal.metadata?.sessionId === session.id,
							};
						}),
					});
				});
	
	app.post('/v1/auth/web/sessions/:sessionId/revoke', async (c) => {
					const auth = await ensurePrincipal(c);
					if (auth.response) return auth.response;
					const sessionId = c.req.param('sessionId');
					if (auth.principal.metadata?.sessionId === sessionId) return jsonError(c, 409, 'Use sign out to end the current session.', { code: 'current_session' });
					const existing = await store.first(`SELECT revoked_at FROM auth_sessions WHERE id = ? AND user_id = ? LIMIT 1`, [sessionId, auth.principal.id]);
					if (!existing) return c.json({ ok: true, payload: { id: sessionId, status: 'not-found' } });
					await store.run(
						`UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, ?), updated_at = ? WHERE id = ? AND user_id = ?`,
						[new Date().toISOString(), new Date().toISOString(), sessionId, auth.principal.id],
					);
					return c.json({ ok: true, payload: { id: sessionId, status: existing.revoked_at ? 'already-revoked' : 'revoked' } });
				});
	
	app.patch('/v1/auth/web/profile', async (c) => {
					const auth = await ensurePrincipal(c);
					if (auth.response) return auth.response;
					const body = await readJsonOrFormBody(c);
					const firstName = optionalTrimmedString(body.firstName);
					const lastName = optionalTrimmedString(body.lastName);
					const displayName = String(body.displayName ?? body.name ?? [firstName, lastName].filter(Boolean).join(' ')).trim();
					const image = optionalTrimmedString(body.image);
					if (!displayName) return jsonError(c, 400, 'Display name is required.');
					const metadata = {
						...(auth.principal.metadata ?? {}),
						firstName,
						lastName,
						image,
					};
					await store.run(`UPDATE users SET display_name = ?, metadata_json = ?, updated_at = ? WHERE id = ?`, [
						displayName,
						JSON.stringify(metadata),
						new Date().toISOString(),
						auth.principal.id,
					]);
					return c.json({ ok: true, payload: { changed: true } });
				});
	
	app.get('/v1/auth/web/appearance', async (c) => {
					const auth = await ensurePrincipal(c);
					if (auth.response) return auth.response;
					return c.json({
						ok: true,
						payload: normalizeAppearancePreference(auth.principal.metadata?.appearance ?? {}),
					});
				});
	
	app.patch('/v1/auth/web/appearance', async (c) => {
					const auth = await ensurePrincipal(c);
					if (auth.response) return auth.response;
					const body = await readJsonOrFormBody(c);
					const appearance = normalizeAppearancePreference(body);
					if (appearance.scheme.startsWith('personal-')) {
						const themeId = appearance.scheme.slice('personal-'.length);
						const owned = await store.first(`SELECT id FROM user_personal_themes WHERE id = ? AND user_id = ? LIMIT 1`, [themeId, auth.principal.id]);
						if (!owned) return jsonError(c, 404, 'Personal theme was not found.');
					}
					const metadata = {
						...(auth.principal.metadata ?? {}),
						appearance,
					};
					await store.run(`UPDATE users SET metadata_json = ?, updated_at = ? WHERE id = ?`, [
						JSON.stringify(metadata),
						new Date().toISOString(),
						auth.principal.id,
					]);
					const session = await createMarketWebSession(runtimeMarketAuthProvider, auth.principal.id, webSessionData(c, 'appearance_update'), { store, authSecret: runtime.resolved.config.authSecret });
					return c.json({ ok: true, payload: { ...webAuthPayload(session), ...appearance } });
				});
	
	app.get('/v1/auth/web/themes', async (c) => {
					const auth = await ensurePrincipal(c);
					if (auth.response) return auth.response;
					const rows = await store.all(`SELECT * FROM user_personal_themes WHERE user_id = ? ORDER BY normalized_name`, [auth.principal.id]);
					return c.json({ ok: true, payload: rows.map(personalThemeFromRow) });
				});
	
	app.post('/v1/auth/web/themes', async (c) => {
					const auth = await ensurePrincipal(c);
					if (auth.response) return auth.response;
					const body = await readJsonOrFormBody(c);
					const draft = typeof body.palette === 'string' ? { ...body, palette: JSON.parse(body.palette) } : body;
					if (!isValidPersonalThemeDraft(draft)) return jsonError(c, 400, 'Theme name and valid light/dark palette colors are required.');
					const id = randomUUID();
					const now = new Date().toISOString();
					try {
						await store.run(`INSERT INTO user_personal_themes (id, user_id, name, normalized_name, base_scheme, palette_json, compiler_version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [id, auth.principal.id, draft.name.trim(), draft.name.trim().toLowerCase(), draft.baseScheme.trim(), JSON.stringify(draft.palette), PERSONAL_THEME_COMPILER_VERSION, now, now]);
					} catch {
						return jsonError(c, 409, 'A personal theme with that name already exists.', { code: 'theme_name_conflict' });
					}
					return c.json({ ok: true, payload: personalThemeFromRow(await store.first(`SELECT * FROM user_personal_themes WHERE id = ?`, [id])) }, 201);
				});
	
	app.patch('/v1/auth/web/themes/:themeId', async (c) => {
					const auth = await ensurePrincipal(c);
					if (auth.response) return auth.response;
					const existing = await store.first(`SELECT * FROM user_personal_themes WHERE id = ? AND user_id = ? LIMIT 1`, [c.req.param('themeId'), auth.principal.id]);
					if (!existing) return jsonError(c, 404, 'Personal theme was not found.');
					const body = await readJsonOrFormBody(c);
					const draft = typeof body.palette === 'string' ? { ...body, palette: JSON.parse(body.palette) } : body;
					if (!isValidPersonalThemeDraft(draft)) return jsonError(c, 400, 'Theme name and valid light/dark palette colors are required.');
					try {
						await store.run(`UPDATE user_personal_themes SET name = ?, normalized_name = ?, base_scheme = ?, palette_json = ?, compiler_version = ?, updated_at = ? WHERE id = ? AND user_id = ?`, [draft.name.trim(), draft.name.trim().toLowerCase(), draft.baseScheme.trim(), JSON.stringify(draft.palette), PERSONAL_THEME_COMPILER_VERSION, new Date().toISOString(), existing.id, auth.principal.id]);
					} catch {
						return jsonError(c, 409, 'A personal theme with that name already exists.', { code: 'theme_name_conflict' });
					}
					return c.json({ ok: true, payload: personalThemeFromRow(await store.first(`SELECT * FROM user_personal_themes WHERE id = ?`, [existing.id])) });
				});
	
	app.delete('/v1/auth/web/themes/:themeId', async (c) => {
					const auth = await ensurePrincipal(c);
					if (auth.response) return auth.response;
					const themeId = c.req.param('themeId');
					const existing = await store.first(`SELECT id FROM user_personal_themes WHERE id = ? AND user_id = ? LIMIT 1`, [themeId, auth.principal.id]);
					if (!existing) return jsonError(c, 404, 'Personal theme was not found.');
					const user = await store.first(`SELECT metadata_json FROM users WHERE id = ? LIMIT 1`, [auth.principal.id]);
					const appearance = normalizeAppearancePreference(parseJsonObject(user?.metadata_json).appearance ?? {});
					if (appearance.scheme === `personal-${themeId}`) return jsonError(c, 409, 'Switch themes from the theme selector before deleting the active theme.', { code: 'active_theme' });
					await store.run(`DELETE FROM user_personal_themes WHERE id = ? AND user_id = ?`, [themeId, auth.principal.id]);
					return c.json({ ok: true, payload: { id: themeId, deleted: true } });
				});
	
	app.get('/v1/auth/web/notifications/preferences', async (c) => {
					const auth = await ensurePrincipal(c);
					if (auth.response) return auth.response;
					return c.json({ ok: true, payload: await loadNotificationPreferences(store, auth.principal.id), capabilities: NOTIFICATION_CONTENT_CAPABILITIES });
				});
	
	app.put('/v1/auth/web/notifications/preferences', async (c) => {
					const auth = await ensurePrincipal(c);
					if (auth.response) return auth.response;
					const body = await readJsonOrFormBody(c);
					const input = typeof body.preferences === 'string' ? JSON.parse(body.preferences) : body;
					const preferences = normalizeNotificationPreferences(input);
					try { new Intl.DateTimeFormat('en', { timeZone: preferences.timeZone }); } catch { return jsonError(c, 400, 'A valid IANA time zone is required.'); }
					const projects = await store.listProjectsForPrincipal(auth.principal);
					const allowed = new Set(projects.map((project) => project.id));
					if (preferences.projectOverrides.some((entry) => !allowed.has(entry.projectId))) return jsonError(c, 403, 'A selected project is unavailable.');
					const now = new Date().toISOString();
					const replacements = [
						{ query: `INSERT INTO user_notification_preferences (user_id, email_cadence, time_zone, created_at, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (user_id) DO UPDATE SET email_cadence = EXCLUDED.email_cadence, time_zone = EXCLUDED.time_zone, updated_at = EXCLUDED.updated_at`, params: [auth.principal.id, preferences.emailCadence, preferences.timeZone, now, now] },
						{ query: `DELETE FROM user_notification_global_content_types WHERE user_id = ?`, params: [auth.principal.id] },
						{ query: `DELETE FROM user_notification_project_content_types WHERE user_id = ?`, params: [auth.principal.id] },
						{ query: `DELETE FROM user_notification_project_overrides WHERE user_id = ?`, params: [auth.principal.id] },
						...preferences.globalContentTypes.map((contentType) => ({ query: `INSERT INTO user_notification_global_content_types (user_id, content_type) VALUES (?, ?)`, params: [auth.principal.id, contentType] })),
					];
					for (const override of preferences.projectOverrides) {
						replacements.push({ query: `INSERT INTO user_notification_project_overrides (user_id, project_id, created_at, updated_at) VALUES (?, ?, ?, ?)`, params: [auth.principal.id, override.projectId, now, now] });
						for (const contentType of override.contentTypes) replacements.push({ query: `INSERT INTO user_notification_project_content_types (user_id, project_id, content_type) VALUES (?, ?, ?)`, params: [auth.principal.id, override.projectId, contentType] });
					}
					await store.batch(replacements);
					return c.json({ ok: true, payload: await loadNotificationPreferences(store, auth.principal.id) });
				});
	
	app.get('/v1/auth/web/notifications', async (c) => {
					const auth = await ensurePrincipal(c);
					if (auth.response) return auth.response;
					const allowedProjects = new Set((await store.listProjectsForPrincipal(auth.principal)).map((project) => project.id));
					const limit = Math.min(100, Math.max(1, Number(c.req.query('limit') ?? 20)));
					const rows = await store.all(`SELECT user_notifications.id, user_notifications.read_at, user_notifications.created_at, notification_events.* FROM user_notifications INNER JOIN notification_events ON notification_events.id = user_notifications.event_id WHERE user_notifications.user_id = ? ORDER BY user_notifications.created_at DESC LIMIT ?`, [auth.principal.id, limit * 3]);
					return c.json({ ok: true, payload: rows.filter((row) => allowedProjects.has(row.project_id)).slice(0, limit).map((row) => ({ id: row.id, eventType: row.event_type, contentType: row.content_type, projectId: row.project_id, title: row.title, summary: row.summary, targetUrl: row.target_url, createdAt: row.created_at, readAt: row.read_at })) });
				});
	
	app.post('/v1/auth/web/notifications/:notificationId/read', async (c) => {
					const auth = await ensurePrincipal(c);
					if (auth.response) return auth.response;
					const row = await store.first(`SELECT id, read_at FROM user_notifications WHERE id = ? AND user_id = ? LIMIT 1`, [c.req.param('notificationId'), auth.principal.id]);
					if (!row) return jsonError(c, 404, 'Notification was not found.');
					const readAt = row.read_at ?? new Date().toISOString();
					await store.run(`UPDATE user_notifications SET read_at = ? WHERE id = ? AND user_id = ?`, [readAt, row.id, auth.principal.id]);
					return c.json({ ok: true, payload: { id: row.id, readAt } });
				});
}
