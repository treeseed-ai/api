export function installAuthenticationAuthWebPasswordThroughAuthLogoutRoutes(context: any) {
	const { AGENT_PROMOTION_APPROVAL_DECISIONS, AGENT_TASK_SIGNATURES, AUTH_PROVIDERS, AgentSdk, CHECKOUT_COMMERCIAL_OFFER_MODES, CHECKOUT_OFFER_MODES, CHECKOUT_SUBSCRIPTION_OFFER_MODES, DatabaseAuthProvider, FEEDBACK_SCREENSHOT_TYPES, FEEDBACK_TYPES, GITHUB_ACTIONS_OIDC_ISSUER, HOST_KIND_SESSION_KEYS, LOCAL_CONTENT_COLLECTIONS, LOCAL_CONTENT_DEFAULTS, LOCAL_DECISION_TYPE_VALUES, LOCAL_WORK_CONTENT_COLLECTIONS, MARKET_EMAIL_CONFIRMATION_PREFIX, MAX_FEEDBACK_MESSAGE_LENGTH, MAX_FEEDBACK_SCREENSHOT_BYTES, MarketControlPlaneStore, NOTIFICATION_CONTENT_CAPABILITIES, PERSONAL_THEME_COMPILER_VERSION, PLAINTEXT_HOST_CREDENTIAL_FIELD_NAMES, PLATFORM_OPERATION_SCOPES, POSTGRES_AUTH_PROVIDER_ID, PROPOSAL_VERDICT_DECISION_TYPES, RemoteTreeseedClient, RemoteTreeseedOperationsClient, RemoteTreeseedSdkClient, SENSITIVE_QUERY_PARAM_PATTERN, STRIPE_PRICE_MIRROR_OFFER_MODES, STRIPE_PRODUCT_MIRROR_OFFER_MODES, TreeseedOperationsSdk, accountDeletionBlockers, accountDeletionConfirmationMatches, addRelationValue, apiDatabaseUrl, app, appendLaunchDeploymentEvent, appendLaunchPhaseProjection, appendProjectDeletionProgress, applyCommerceRefundState, applyContentPublishResult, applyHubLaunchFailure, applyHubLaunchResult, applySeedWithStore, artifactDownloadPayload, authConfig, authEmailDeliveryFailureDetail, authEmailDeliveryFailureReason, authProviderId, authTokenTimestampMillis, authTokenTimestampSeconds, availabilityAttempts, availabilityRateLimit, backfillUserEmailAddresses, base64Url, base64urlJson, bearerTokenFromRequest, buildCommerceCheckoutMetadata, buildCommerceStripeMetadata, buildGovernanceApprovalProjection, buildGovernanceProjection, buildInfrastructureProjection, buildKnowledgeArtifactProjection, buildKnowledgeProjection, buildLaunchCredentialOverlay, buildWorkdayProjection, canSkipCloudflareCleanupAfterFailedLaunch, canonicalArchitectureTopology, capacity, centralMarketProfile, checkoutGroupKey, checkoutGroupKind, checkoutGroupStatus, ciOperationForAction, cleanFeedbackString, cloudflareDeletionAuthenticationMessage, cloudflareDnsDomainsForHostValidation, cloudflareErrorMessage, cloudflareProjectDeletionResourceNames, cloudflareRequestForLaunchPreflight, cloudflareRequestForProjectDeletion, collectHostingAuditCredentialOverlay, commerceCheckoutError, commerceErrorResponse, commerceStripeLookupKey, commerceStripePriceParams, commerceStripeProductParams, commerceStripeSyncContext, config, configuredAuthProviderId, confirmationUrlFor, consumeReauthentication, contentRelationPolicy, createApiApp, createApiExtension, createCapacityControlPlane, createCipheriv, createClientEncryptedEscrowService, createCommerceCheckoutRun, createCommerceCheckoutRunForServiceContract, createDecipheriv, createDecisionFromProposals, createGitHubActionsSecretEnclave, createGitHubAppAdapter, createHash, createHmac, createMarketEmailConfirmation, createMarketPostgresDatabase, createMarketWebSession, createOrResendUserEmailAddress, createProjectHostCredentialSessions, createProjectInternalClient, createPublicKey, createRelatedLocalContentRecord, createStripeConnectService, createTreeDxCredentialBridge, createTreeseedApiApp, createVerify, credentialSessionKey, credentialSessionSecret, db, decodeRouteParam, decorateJob, decoratePlatformOperation, decryptCredentialSessionPayload, decryptHostConfig, decryptTeamHostForLaunch, decryptedHostConfigSummary, defaultConfig, deleteCloudflareDnsRecordsForProject, deleteCloudflareProjectResources, deleteTeamCapacityAggregate, derivePlatformOperationNavigation, deriveProjectHostBindingsView, domainInZone, encryptCredentialSessionPayload, encryptedHostPayloadLooksValid, enqueueTreeDxProvisionOperation, ensureCommerceStripeCustomer, ensureMarketCredentialSchema, ensurePrincipal, entitlementRenewalStateFromSubscription, enumValue, exchangeProviderIdentity, executeInline, executeProjectApi, executeSdkOperation, existsSync, exportSeedWithStore, exposeAuthTokenForTests, fallbackRemoteCapability, findById, findDispatchCapability, getSiteAuthConfig, getUserEmailAddress, githubOidcJwksCache, githubRequestForProjectDeletion, grantCommerceEntitlementsForOrder, handleCommerceInvoiceWebhook, handleCommercePaymentIntentWebhook, handleCommerceSubscriptionWebhook, hasRecordedCloudflareRuntimeResources, hashMarketPassword, hostBindingRequiresUnlock, hostKindForBinding, hubRepositoryPolicies, inferZoneNameForDomain, installApiRequestLogger, installCapacityRoutes, installProjectDeploymentRoutes, isLocalAcceptanceServicePrincipal, isLoopbackUrl, isPlatformOperationTerminal, isTeamApiPrincipal, isValidPersonalThemeDraft, jsonError, jsonThrownError, launchCapabilityPreset, launchPlannerRepositoryTopology, listCloudflareNamedResources, listTreeseedManagedHostsFromConfig, listUserEmailAddresses, loadGitHubOidcJwks, loadInfrastructureSeedState, loadKnowledgeContentEntries, loadNotificationPreferences, loadProjectHostBindingContext, loadTemplateCatalog, localAcceptanceAdminToken, localAcceptanceAuthEnabled, localContentPath, localContentRoot, logRequests, managedCloudflareConfigMissing, markdownToPlainProjectSummary, marketAuthContext, marketEmailTokenHash, marketProfilesForTeams, mergeCapability, mergeStringConfig, mkdir, nonSecretLaunchJobInput, normalizeAppearancePreference, normalizeAuditHostKinds, normalizeBaseUrl, normalizeCheckoutQuantity, normalizeCiEnvironment, normalizeDomainName, normalizeEmail, normalizeLocalContentInput, normalizeMarketProfile, normalizeNotificationPreferences, normalizeProjectDomainInput, normalizeProjectLaunchHostBindings, normalizeProviderCredentialConfig, normalizeRelationArray, normalizeRepositoryContentInput, normalizeRepositoryRelationArray, normalizeRepositorySlug, normalizeSeedEnvironments, normalizeTemplateLaunchRequirements, normalizeTreeseedTemplateId, normalizeUsername, normalizedCloudflareKvNamespaceReference, operationTokenSecret, optionalTrimmedString, orderStatusFromPaymentGroup, parseBase64urlJson, parseBooleanEnvValue, parseJsonObject, parseYaml, passwordResetUrlFor, patchLaunchIntentForCredentialOverlay, paymentGroupStatusFromPaymentIntent, pbkdf2Sync, persistProjectHostBindingOperationMetadata, personalThemeFromRow, plaintextHostCredentialFieldPaths, planKnowledgeHubLaunch, planProjectHostBindingOperation, planSeedWithStore, platformOperationMutationError, principalCanManageCommerceProduct, principalHasGlobalPlatformRole, principalHasPermission, principalIsSeedAdmin, privateKnowledgeAuditPayload, processCommerceStripeWebhook, projectAllowedCiRepositories, projectApiConnection, projectAppHref, projectDeletionBlockerRows, projectDeletionConfirmationMatches, projectDeletionHostname, projectDeletionOperation, projectHostBindingMetadata, projectHostResponsePayload, providerConfigFor, providerCredentialValuesForAudit, providerJwksCache, publicPaymentGroups, randomBytes, randomUUID, readCapacityRequestObject, readFile, readJsonOrFormBody, readLocalContentRecord, recordContentNotificationEvent, recordFeedbackSubmission, recordPrivateKnowledgeAudit, redactCommerceOwnershipWorkflow, redactCommerceServiceRequestForBuyer, redactedRequestTarget, refreshCommercePaymentGroupState, refreshCommerceStripeAccount, rejectPlaintextHostCredentialFields, rejectProjectSecretUnlockMaterial, relative, remainingRefundableAmount, repositoryContentRelationPolicy, repositoryInventoryWithPlatform, requestClientIp, requestSessionMetadata, requireCatalogItemAccess, requireCommerceCapacityInquiryAccess, requireCommerceCapacityListingAccess, requireCommerceOfferAccess, requireCommerceProductAccess, requireCommerceVendorForStripe, requireConfiguredServiceCredential, requireConnectedProjectRuntime, requirePlatformRunner, requireProjectAccess, requireProjectRunner, requireSeedApplyAccess, requireSeedPlanAccess, requireSellerTeamAccess, requireServiceBuyerAccess, requireServiceParticipantAccess, requireServiceSellerAccess, requireTeamAccess, requireVendorOrderManager, resolve, resolveAgentArtifactBucket, resolveAgentTaskSignature, resolveApiConfig, resolveAuthApprovalBaseUrl, resolveCloudflareZoneForLaunchPreflight, resolveCommerceCheckoutItem, resolveFulfillmentArtifact, resolveLaunchTemplateRequirements, resolveOrderItemForRefund, resolvePlatformRepositoryDescriptor, resolvePlatformRunnerSecret, resolveProjectDeletionCloudflareZone, resolveProjectLaunchHostBindings, resolvePublicTreeDxTeam, resolveStripeEnvironment, resolveStripePublishableKey, resolveStripeWebhookSecret, resolveTreeseedManagedCloudflareHostConfigFromConfig, resolveUiProjectionContext, resourceRowsFromLaunch, retryApiLaunchBootstrapFromRequest, rm, runProjectDeletionApiDestroy, runProjectLaunchApiBootstrap, runTreeseedHostingAudit, runtime, runtimeMarketAuthProvider, runtimeProviders, safeFeedbackClient, safeFeedbackContext, safeFeedbackScreenshot, safePlatformOperationOutput, safePrivateKnowledgeSlug, safeTokenEquals, sanitizeLaunchResultForStorage, sanitizedReturnTo, scheduleBackgroundBootstrap, seedActor, seedCreatesMissingTeams, seedExistingTeamIds, selectDispatchTarget, sendAuthEmail, sendEmailConfirmation, sendTeamInviteEmail, sendWelcomeEmail, serializeFrontmatter, serializeUserEmailAddress, setPrimaryEmailAddress, sharedSdk, shouldBypassAcceptanceAuthEmailDelivery, shouldExposeNonProductionAuthDiagnostics, shouldLogApiRequests, signEditorialPreviewToken, signOperationToken, slugifyContent, slugifyRepositoryContent, sourceFromProjectDetails, store, stripeAccountMissingError, stripeAccountToConnectedAccountPatch, stripeClientSecret, stripeCommerceUrl, stripeConfiguredError, stripeConnectService, stripeMetadataValue, stripePriceTermsDrift, stripeRefundStatus, stripeTimestampToIso, stripeVendorApprovalError, subscriptionClientSecret, subscriptionStatusFromStripe, syncCommerceOfferStripeProduct, syncCommercePriceStripePrice, syncCommerceSubscriptionFromStripe, syncPrimaryEmailCaches, teamInviteAcceptUrlFor, timingSafeEqual, trimmedHeaderValue, uiRuntimeLocals, uniqueCloudflareKvNamespaceReferences, uniqueRelationArray, unknownKeys, unwrapLaunchOperationOutput, unwrapOperationPayload, updateCheckoutCompletionFromGroup, updateLaunchDeployments, validateCiRefForEnvironment, validateFeedbackAccess, validateMarketPassword, validateProjectSlug, validatePublicUsername, validateTeamHostCredentialPayload, verifiedEmailCount, verifyCloudflareDnsWriteForLaunch, verifyGitHubOidcToken, verifyMarketPassword, verifyOperationToken, verifyProviderIdToken, webAuthPayload, webSessionData, writeFile, writeLocalContentRecord, writeParsedLocalContentRecord, yamlLines, yamlScalar } = context;
	app.patch('/v1/auth/web/password', async (c) => {
					await ensureMarketCredentialSchema(store);
					const auth = await ensurePrincipal(c);
					if (auth.response) return auth.response;
					const body = await readJsonOrFormBody(c);
					const currentPassword = String(body.currentPassword ?? '');
					const newPassword = String(body.newPassword ?? body.password ?? '');
					if (!validateMarketPassword(newPassword)) return jsonError(c, 400, 'Password must be at least 12 characters.');
					const row = await store.first(`SELECT password_hash FROM market_auth_credentials WHERE user_id = ? LIMIT 1`, [auth.principal.id]);
					if (!await consumeReauthentication(store, auth.principal, 'password_change', body)) return jsonError(c, 401, 'Reauthentication is required.', { code: 'reauthentication_required' });
					if (!row) {
						const email = normalizeEmail(auth.principal.metadata?.email);
						const username = normalizeUsername(auth.principal.metadata?.username ?? auth.principal.id);
						await store.run(
							`INSERT INTO market_auth_credentials (user_id, email, username, password_hash, status, created_at, updated_at)
							 VALUES (?, ?, ?, ?, 'active', ?, ?)`,
							[auth.principal.id, email || `${auth.principal.id}@treeseed.local`, username || null, hashMarketPassword(newPassword), new Date().toISOString(), new Date().toISOString()],
						);
					} else {
						await store.run(`UPDATE market_auth_credentials SET password_hash = ?, updated_at = ? WHERE user_id = ?`, [
							hashMarketPassword(newPassword),
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
					const credential = await store.first(`SELECT password_hash FROM market_auth_credentials WHERE user_id = ? AND status = 'active' LIMIT 1`, [auth.principal.id]);
					if (!credential || !verifyMarketPassword(String(body.password ?? ''), credential.password_hash)) return jsonError(c, 401, 'Current password was not accepted.');
					const grantId = randomUUID();
					await store.run(`INSERT INTO auth_reauthentication_grants (id, user_id, session_id, action, expires_at, consumed_at, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?)`, [grantId, auth.principal.id, auth.principal.metadata?.sessionId ?? '', action, new Date(Date.now() + 5 * 60_000).toISOString(), new Date().toISOString()]);
					return c.json({ ok: true, payload: { grantId, action, expiresInSeconds: 300 } });
				});
	
	app.post('/v1/auth/web/password-reset/request', async (c) => {
					await ensureMarketCredentialSchema(store);
					const body = await readJsonOrFormBody(c);
					const email = normalizeEmail(body.email);
					const row = email
						? await store.first(
							`SELECT market_auth_credentials.user_id
							   FROM market_auth_credentials
							   INNER JOIN user_email_addresses
							      ON user_email_addresses.user_id = market_auth_credentials.user_id
							     AND user_email_addresses.normalized_email = ?
							     AND user_email_addresses.status = 'verified'
							  WHERE market_auth_credentials.status = 'active'
							  LIMIT 1`,
							[email],
						)
						: null;
					let resetToken = null;
					if (row) {
						resetToken = `reset_${randomBytes(24).toString('base64url')}`;
						await store.run(
							`INSERT INTO market_auth_password_resets (id, user_id, token_hash, expires_at, used_at, created_at)
							 VALUES (?, ?, ?, ?, NULL, ?)`,
							[
								randomUUID(),
								row.user_id,
								createHash('sha256').update(resetToken).digest('hex'),
								new Date(Date.now() + 60 * 60 * 1000).toISOString(),
								new Date().toISOString(),
							],
						);
						const resetUrl = passwordResetUrlFor(marketAuthContext(c), resetToken);
						try {
							if (!shouldBypassAcceptanceAuthEmailDelivery(c, runtime.resolved.config)) {
								await sendAuthEmail(marketAuthContext(c), {
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
							}
						} catch (error) {
							console.warn('[market-auth] Password reset email failed:', error instanceof Error ? error.message : String(error));
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
							resetToken: process.env.NODE_ENV === 'test' || process.env.TREESEED_ACCEPTANCE_EXPOSE_RESET_TOKENS === '1' ? resetToken : undefined,
						},
					});
				});
	
	app.post('/v1/auth/web/password-reset/complete', async (c) => {
					await ensureMarketCredentialSchema(store);
					const body = await readJsonOrFormBody(c);
					const token = String(body.token ?? '');
					const newPassword = String(body.newPassword ?? body.password ?? '');
					if (!token || !validateMarketPassword(newPassword)) return jsonError(c, 400, 'A valid reset token and password are required.');
					const row = await store.first(
						`SELECT * FROM market_auth_password_resets WHERE token_hash = ? AND used_at IS NULL LIMIT 1`,
						[createHash('sha256').update(token).digest('hex')],
					);
					if (!row || new Date(row.expires_at).getTime() <= Date.now()) return jsonError(c, 401, 'Password reset token is invalid or expired.');
					await store.run(`UPDATE market_auth_credentials SET password_hash = ?, updated_at = ? WHERE user_id = ?`, [
						hashMarketPassword(newPassword),
						new Date().toISOString(),
						row.user_id,
					]);
					await store.run(`UPDATE market_auth_password_resets SET used_at = ? WHERE id = ?`, [new Date().toISOString(), row.id]);
					return c.json({ ok: true });
				});
	
	app.get('/v1/auth/web/account/deletion-blockers', async (c) => {
					const auth = await ensurePrincipal(c);
					if (auth.response) return auth.response;
					const blockers = await accountDeletionBlockers(store, auth.principal);
					return c.json({ ok: true, payload: { blockers, canDelete: blockers.length === 0 } });
				});
	
	app.delete('/v1/auth/web/account', async (c) => {
					await ensureMarketCredentialSchema(store);
					const auth = await ensurePrincipal(c);
					if (auth.response) return auth.response;
					const body = await readJsonOrFormBody(c);
					if (!accountDeletionConfirmationMatches(String(body.confirmation ?? ''))) {
						return jsonError(c, 409, 'Type "DELETE MY ACCOUNT" to delete this account.', { code: 'confirmation' });
					}
					const blockers = await accountDeletionBlockers(store, auth.principal);
					if (blockers.length) return jsonError(c, 409, 'Account deletion is blocked.', { code: 'deletion_blocked', blockers });
					if (!await consumeReauthentication(store, auth.principal, 'account_delete', body)) return jsonError(c, 401, 'Reauthentication is required.', { code: 'reauthentication_required' });
					const now = new Date().toISOString();
					await store.batch([
						{ query: `UPDATE users SET status = 'deleted', updated_at = ? WHERE id = ?`, params: [now, auth.principal.id] },
						{ query: `UPDATE market_auth_credentials SET email = ?, status = 'deleted', updated_at = ? WHERE user_id = ?`, params: [`deleted+${auth.principal.id}@invalid`, now, auth.principal.id] },
						...['user_email_addresses', 'user_identities', 'auth_reauthentication_grants', 'user_personal_themes', 'user_notification_global_content_types', 'user_notification_project_content_types', 'user_notification_project_overrides', 'user_notification_preferences', 'notification_email_deliveries', 'user_notifications'].map((table) => ({ query: `DELETE FROM ${table} WHERE user_id = ?`, params: [auth.principal.id] })),
						{ query: `UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, ?), updated_at = ? WHERE user_id = ?`, params: [now, now, auth.principal.id] },
					]);
					return c.json({ ok: true, payload: { deleted: true } });
				});
	
	app.post('/v1/auth/token/refresh', async (c) => {
					const body = await c.req.json().catch(() => ({}));
					try {
						return c.json(await runtimeMarketAuthProvider.refreshAccessToken({ refreshToken: String(body.refreshToken ?? '') }));
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
					}
					return c.json({ ok: true });
				});
}
