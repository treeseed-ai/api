export function installTeamsRepositoryAndWebHostsRoutes(context: any) {
	const { AGENT_PROMOTION_APPROVAL_DECISIONS, AGENT_TASK_SIGNATURES, AUTH_PROVIDERS, AgentSdk, CHECKOUT_COMMERCIAL_OFFER_MODES, CHECKOUT_OFFER_MODES, CHECKOUT_SUBSCRIPTION_OFFER_MODES, DatabaseAuthProvider, FEEDBACK_SCREENSHOT_TYPES, FEEDBACK_TYPES, GITHUB_ACTIONS_OIDC_ISSUER, HOST_KIND_SESSION_KEYS, LOCAL_CONTENT_COLLECTIONS, LOCAL_CONTENT_DEFAULTS, LOCAL_DECISION_TYPE_VALUES, LOCAL_WORK_CONTENT_COLLECTIONS, MARKET_EMAIL_CONFIRMATION_PREFIX, MAX_FEEDBACK_MESSAGE_LENGTH, MAX_FEEDBACK_SCREENSHOT_BYTES, MarketControlPlaneStore, NOTIFICATION_CONTENT_CAPABILITIES, PERSONAL_THEME_COMPILER_VERSION, PLAINTEXT_HOST_CREDENTIAL_FIELD_NAMES, PLATFORM_OPERATION_SCOPES, POSTGRES_AUTH_PROVIDER_ID, PROPOSAL_VERDICT_DECISION_TYPES, RemoteTreeseedClient, RemoteTreeseedOperationsClient, RemoteTreeseedSdkClient, SENSITIVE_QUERY_PARAM_PATTERN, STRIPE_PRICE_MIRROR_OFFER_MODES, STRIPE_PRODUCT_MIRROR_OFFER_MODES, TreeseedOperationsSdk, accountDeletionBlockers, accountDeletionConfirmationMatches, addRelationValue, apiDatabaseUrl, app, appendLaunchDeploymentEvent, appendLaunchPhaseProjection, appendProjectDeletionProgress, applyCommerceRefundState, applyContentPublishResult, applyHubLaunchFailure, applyHubLaunchResult, applySeedWithStore, artifactDownloadPayload, authConfig, authEmailDeliveryFailureDetail, authEmailDeliveryFailureReason, authProviderId, authTokenTimestampMillis, authTokenTimestampSeconds, availabilityAttempts, availabilityRateLimit, backfillUserEmailAddresses, base64Url, base64urlJson, bearerTokenFromRequest, buildCommerceCheckoutMetadata, buildCommerceStripeMetadata, buildGovernanceApprovalProjection, buildGovernanceProjection, buildInfrastructureProjection, buildKnowledgeArtifactProjection, buildKnowledgeProjection, buildLaunchCredentialOverlay, buildWorkdayProjection, canSkipCloudflareCleanupAfterFailedLaunch, canonicalArchitectureTopology, capacity, centralMarketProfile, checkoutGroupKey, checkoutGroupKind, checkoutGroupStatus, ciOperationForAction, cleanFeedbackString, cloudflareDeletionAuthenticationMessage, cloudflareDnsDomainsForHostValidation, cloudflareErrorMessage, cloudflareProjectDeletionResourceNames, cloudflareRequestForLaunchPreflight, cloudflareRequestForProjectDeletion, collectHostingAuditCredentialOverlay, commerceCheckoutError, commerceErrorResponse, commerceStripeLookupKey, commerceStripePriceParams, commerceStripeProductParams, commerceStripeSyncContext, config, configuredAuthProviderId, confirmationUrlFor, consumeReauthentication, contentRelationPolicy, createApiApp, createApiExtension, createCapacityControlPlane, createCipheriv, createClientEncryptedEscrowService, createCommerceCheckoutRun, createCommerceCheckoutRunForServiceContract, createDecipheriv, createDecisionFromProposals, createGitHubActionsSecretEnclave, createGitHubAppAdapter, createHash, createHmac, createMarketEmailConfirmation, createMarketPostgresDatabase, createMarketWebSession, createOrResendUserEmailAddress, createProjectHostCredentialSessions, createProjectInternalClient, createPublicKey, createRelatedLocalContentRecord, createStripeConnectService, createTreeDxCredentialBridge, createTreeseedApiApp, createVerify, credentialSessionKey, credentialSessionSecret, db, decodeRouteParam, decorateJob, decoratePlatformOperation, decryptCredentialSessionPayload, decryptHostConfig, decryptTeamHostForLaunch, decryptedHostConfigSummary, defaultConfig, deleteCloudflareDnsRecordsForProject, deleteCloudflareProjectResources, deleteTeamCapacityAggregate, derivePlatformOperationNavigation, deriveProjectHostBindingsView, domainInZone, encryptCredentialSessionPayload, encryptedHostPayloadLooksValid, enqueueTreeDxProvisionOperation, ensureCommerceStripeCustomer, ensureMarketCredentialSchema, ensurePrincipal, entitlementRenewalStateFromSubscription, enumValue, exchangeProviderIdentity, executeInline, executeProjectApi, executeSdkOperation, existsSync, exportSeedWithStore, exposeAuthTokenForTests, fallbackRemoteCapability, findById, findDispatchCapability, getSiteAuthConfig, getUserEmailAddress, githubOidcJwksCache, githubRequestForProjectDeletion, grantCommerceEntitlementsForOrder, handleCommerceInvoiceWebhook, handleCommercePaymentIntentWebhook, handleCommerceSubscriptionWebhook, hasRecordedCloudflareRuntimeResources, hashMarketPassword, hostBindingRequiresUnlock, hostKindForBinding, hubRepositoryPolicies, inferZoneNameForDomain, installApiRequestLogger, installCapacityRoutes, installProjectDeploymentRoutes, isLocalAcceptanceServicePrincipal, isLoopbackUrl, isPlatformOperationTerminal, isTeamApiPrincipal, isValidPersonalThemeDraft, jsonError, jsonThrownError, launchCapabilityPreset, launchPlannerRepositoryTopology, listCloudflareNamedResources, listTreeseedManagedHostsFromConfig, listUserEmailAddresses, loadGitHubOidcJwks, loadInfrastructureSeedState, loadKnowledgeContentEntries, loadNotificationPreferences, loadProjectHostBindingContext, loadTemplateCatalog, localAcceptanceAdminToken, localAcceptanceAuthEnabled, localContentPath, localContentRoot, logRequests, managedCloudflareConfigMissing, markdownToPlainProjectSummary, marketAuthContext, marketEmailTokenHash, marketProfilesForTeams, mergeCapability, mergeStringConfig, mkdir, nonSecretLaunchJobInput, normalizeAppearancePreference, normalizeAuditHostKinds, normalizeBaseUrl, normalizeCheckoutQuantity, normalizeCiEnvironment, normalizeDomainName, normalizeEmail, normalizeLocalContentInput, normalizeMarketProfile, normalizeNotificationPreferences, normalizeProjectDomainInput, normalizeProjectLaunchHostBindings, normalizeProviderCredentialConfig, normalizeRelationArray, normalizeRepositoryContentInput, normalizeRepositoryRelationArray, normalizeRepositorySlug, normalizeSeedEnvironments, normalizeTemplateLaunchRequirements, normalizeTreeseedTemplateId, normalizeUsername, normalizedCloudflareKvNamespaceReference, operationTokenSecret, optionalTrimmedString, orderStatusFromPaymentGroup, parseBase64urlJson, parseBooleanEnvValue, parseJsonObject, parseYaml, passwordResetUrlFor, patchLaunchIntentForCredentialOverlay, paymentGroupStatusFromPaymentIntent, pbkdf2Sync, persistProjectHostBindingOperationMetadata, personalThemeFromRow, plaintextHostCredentialFieldPaths, planKnowledgeHubLaunch, planProjectHostBindingOperation, planSeedWithStore, platformOperationMutationError, principalCanManageCommerceProduct, principalHasGlobalPlatformRole, principalHasPermission, principalIsSeedAdmin, privateKnowledgeAuditPayload, processCommerceStripeWebhook, projectAllowedCiRepositories, projectApiConnection, projectAppHref, projectDeletionBlockerRows, projectDeletionConfirmationMatches, projectDeletionHostname, projectDeletionOperation, projectHostBindingMetadata, projectHostResponsePayload, providerConfigFor, providerCredentialValuesForAudit, providerJwksCache, publicPaymentGroups, randomBytes, randomUUID, readCapacityRequestObject, readFile, readJsonOrFormBody, readLocalContentRecord, recordContentNotificationEvent, recordFeedbackSubmission, recordPrivateKnowledgeAudit, redactCommerceOwnershipWorkflow, redactCommerceServiceRequestForBuyer, redactedRequestTarget, refreshCommercePaymentGroupState, refreshCommerceStripeAccount, rejectPlaintextHostCredentialFields, rejectProjectSecretUnlockMaterial, relative, remainingRefundableAmount, repositoryContentRelationPolicy, repositoryInventoryWithPlatform, requestClientIp, requestSessionMetadata, requireCatalogItemAccess, requireCommerceCapacityInquiryAccess, requireCommerceCapacityListingAccess, requireCommerceOfferAccess, requireCommerceProductAccess, requireCommerceVendorForStripe, requireConfiguredServiceCredential, requireConnectedProjectRuntime, requirePlatformRunner, requireProjectAccess, requireProjectRunner, requireSeedApplyAccess, requireSeedPlanAccess, requireSellerTeamAccess, requireServiceBuyerAccess, requireServiceParticipantAccess, requireServiceSellerAccess, requireTeamAccess, requireVendorOrderManager, resolve, resolveAgentArtifactBucket, resolveAgentTaskSignature, resolveApiConfig, resolveAuthApprovalBaseUrl, resolveCloudflareZoneForLaunchPreflight, resolveCommerceCheckoutItem, resolveFulfillmentArtifact, resolveLaunchTemplateRequirements, resolveOrderItemForRefund, resolvePlatformRepositoryDescriptor, resolvePlatformRunnerSecret, resolveProjectDeletionCloudflareZone, resolveProjectLaunchHostBindings, resolvePublicTreeDxTeam, resolveStripeEnvironment, resolveStripePublishableKey, resolveStripeWebhookSecret, resolveTreeseedManagedCloudflareHostConfigFromConfig, resolveUiProjectionContext, resourceRowsFromLaunch, retryApiLaunchBootstrapFromRequest, rm, runProjectDeletionApiDestroy, runProjectLaunchApiBootstrap, runTreeseedHostingAudit, runtime, runtimeMarketAuthProvider, runtimeProviders, safeFeedbackClient, safeFeedbackContext, safeFeedbackScreenshot, safePlatformOperationOutput, safePrivateKnowledgeSlug, safeTokenEquals, sanitizeLaunchResultForStorage, sanitizedReturnTo, scheduleBackgroundBootstrap, seedActor, seedCreatesMissingTeams, seedExistingTeamIds, selectDispatchTarget, sendAuthEmail, sendEmailConfirmation, sendTeamInviteEmail, sendWelcomeEmail, serializeFrontmatter, serializeUserEmailAddress, setPrimaryEmailAddress, sharedSdk, shouldBypassAcceptanceAuthEmailDelivery, shouldExposeNonProductionAuthDiagnostics, shouldLogApiRequests, signEditorialPreviewToken, signOperationToken, slugifyContent, slugifyRepositoryContent, sourceFromProjectDetails, store, stripeAccountMissingError, stripeAccountToConnectedAccountPatch, stripeClientSecret, stripeCommerceUrl, stripeConfiguredError, stripeConnectService, stripeMetadataValue, stripePriceTermsDrift, stripeRefundStatus, stripeTimestampToIso, stripeVendorApprovalError, subscriptionClientSecret, subscriptionStatusFromStripe, syncCommerceOfferStripeProduct, syncCommercePriceStripePrice, syncCommerceSubscriptionFromStripe, syncPrimaryEmailCaches, teamInviteAcceptUrlFor, timingSafeEqual, trimmedHeaderValue, uiRuntimeLocals, uniqueCloudflareKvNamespaceReferences, uniqueRelationArray, unknownKeys, unwrapLaunchOperationOutput, unwrapOperationPayload, updateCheckoutCompletionFromGroup, updateLaunchDeployments, validateCiRefForEnvironment, validateFeedbackAccess, validateMarketPassword, validateProjectSlug, validatePublicUsername, validateTeamHostCredentialPayload, verifiedEmailCount, verifyCloudflareDnsWriteForLaunch, verifyGitHubOidcToken, verifyMarketPassword, verifyOperationToken, verifyProviderIdToken, webAuthPayload, webSessionData, writeFile, writeLocalContentRecord, writeParsedLocalContentRecord, yamlLines, yamlScalar } = context;
	app.get('/v1/teams/:teamId/web-hosts', async (c) => {
					const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'projects:read:team');
					if (access.response) return access.response;
					return c.json({
						ok: true,
						payload: await store.listTeamWebHosts(c.req.param('teamId')),
					});
				});
	
	app.get('/v1/teams/:teamId/web-hosts/:hostId', async (c) => {
					const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'projects:read:team');
					if (access.response) return access.response;
					const host = await store.getTeamWebHost(c.req.param('teamId'), c.req.param('hostId'));
					if (!host) return jsonError(c, 404, `Unknown web host "${c.req.param('hostId')}".`);
					return c.json({ ok: true, payload: host });
				});
	
	app.get('/v1/teams/:teamId/repository-hosts', async (c) => {
					const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'projects:read:team');
					if (access.response) return access.response;
					return c.json({
						ok: true,
						payload: await store.listRepositoryHosts(c.req.param('teamId')),
					});
				});
	
	app.get('/v1/teams/:teamId/repository-hosts/:hostId', async (c) => {
					const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'projects:read:team');
					if (access.response) return access.response;
					const host = await store.getRepositoryHost(c.req.param('teamId'), c.req.param('hostId'));
					if (!host) return jsonError(c, 404, `Unknown Repository Host "${c.req.param('hostId')}".`);
					return c.json({ ok: true, payload: host });
				});
	
	app.post('/v1/teams/:teamId/repository-hosts', async (c) => {
					const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'teams:manage:team');
					if (access.response) return access.response;
					const body = await c.req.json().catch(() => ({}));
					if (!body.name || !body.organizationOrOwner) {
						return jsonError(c, 400, 'name and organizationOrOwner are required.');
					}
					const plaintextCredentials = rejectPlaintextHostCredentialFields(c, body);
					if (plaintextCredentials) return plaintextCredentials;
					if ((body.ownership ?? 'team_owned') === 'team_owned' && body.encryptedPayload && !encryptedHostPayloadLooksValid(body.encryptedPayload)) {
						return jsonError(c, 400, 'encryptedPayload must use the TreeSeed encrypted host envelope format.');
					}
					try {
						return c.json({
							ok: true,
							payload: await store.upsertRepositoryHost(c.req.param('teamId'), {
								...body,
								provider: 'github',
								createdById: access.principal.id,
								updatedById: access.principal.id,
							}),
						}, { status: 201 });
					} catch (error) {
						return jsonError(c, 400, error instanceof Error ? error.message : String(error));
					}
				});
	
	app.put('/v1/teams/:teamId/repository-hosts/:hostId', async (c) => {
					const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'teams:manage:team');
					if (access.response) return access.response;
					const existing = await store.getRepositoryHost(c.req.param('teamId'), c.req.param('hostId'));
					if (!existing || existing.teamId === null) return jsonError(c, 404, `Unknown Repository Host "${c.req.param('hostId')}".`);
					const body = await c.req.json().catch(() => ({}));
					const plaintextCredentials = rejectPlaintextHostCredentialFields(c, body);
					if (plaintextCredentials) return plaintextCredentials;
					if ((body.ownership ?? existing.ownership) === 'team_owned' && body.encryptedPayload && !encryptedHostPayloadLooksValid(body.encryptedPayload)) {
						return jsonError(c, 400, 'encryptedPayload must use the TreeSeed encrypted host envelope format.');
					}
					try {
						return c.json({
							ok: true,
							payload: await store.upsertRepositoryHost(c.req.param('teamId'), {
								...existing,
								...body,
								id: existing.id,
								provider: 'github',
								updatedById: access.principal.id,
							}),
						});
					} catch (error) {
						return jsonError(c, 400, error instanceof Error ? error.message : String(error));
					}
				});
	
	app.delete('/v1/teams/:teamId/repository-hosts/:hostId', async (c) => {
					const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'teams:manage:team');
					if (access.response) return access.response;
					const result = await store.deleteRepositoryHost(c.req.param('teamId'), c.req.param('hostId'));
					if (!result.ok && result.error === 'in_use') {
						return c.json({ ok: false, error: 'in_use', projects: result.projects }, { status: 409 });
					}
					if (!result.ok) return jsonError(c, 404, `Unknown Repository Host "${c.req.param('hostId')}".`);
					return c.json({ ok: true, payload: result.payload });
				});
	
	app.post('/v1/teams/:teamId/provider-credential-sessions', async (c) => {
					const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'projects:manage:team');
					if (access.response) return access.response;
					const teamId = c.req.param('teamId');
					const body = await c.req.json().catch(() => ({}));
					const hostKind = String(body.hostKind ?? '');
					const hostId = typeof body.hostId === 'string' && body.hostId.trim() ? body.hostId.trim() : null;
					const purpose = typeof body.purpose === 'string' && body.purpose.trim() ? body.purpose.trim() : 'launch_project';
					const passphrase = typeof body.passphrase === 'string' ? body.passphrase : '';
					if (!hostId || !passphrase) {
						return jsonError(c, 400, 'hostId and passphrase are required.');
					}
					let host = null;
					if (hostKind === 'repository_host') {
						host = await store.getRepositoryHost(teamId, hostId);
					} else if (hostKind === 'web_host' || hostKind === 'capacity_provider_host' || hostKind === 'email_host') {
						host = await store.getTeamWebHost(teamId, hostId);
					} else {
						return jsonError(c, 400, 'hostKind must be repository_host, web_host, capacity_provider_host, or email_host.');
					}
					if (!host || host.teamId !== teamId || host.ownership !== 'team_owned') {
						return jsonError(c, 404, 'Selected team-owned provider host is not available for this team.');
					}
					if (!host.encryptedPayload) {
						return jsonError(c, 400, 'Selected host does not have encrypted provider credentials.');
					}
					let normalizedConfig;
					try {
						const decryptedConfig = await decryptHostConfig(host.encryptedPayload, passphrase);
						normalizedConfig = normalizeProviderCredentialConfig(hostKind, decryptedConfig, host);
					} catch (error) {
						return jsonError(c, 400, 'Unable to unlock provider credentials for this host.', {
							message: error instanceof Error ? error.message : String(error),
							hostKind,
							hostId,
						});
					}
					try {
						const requestedSeconds = Number(body.expiresInSeconds ?? 900);
						const expiresInSeconds = Math.max(60, Math.min(Number.isFinite(requestedSeconds) ? requestedSeconds : 900, 3600));
						const session = await store.createProviderCredentialSession(teamId, {
							hostKind,
							hostId,
							purpose,
							expiresAt: new Date(Date.now() + expiresInSeconds * 1000).toISOString(),
							createdById: access.principal.id,
							encryptedPayload: encryptCredentialSessionPayload(runtime, {
								provider: host.provider ?? (hostKind === 'repository_host' ? 'github' : null),
								ownership: host.ownership,
								config: normalizedConfig,
							}),
							metadata: {
								hostName: host.name ?? null,
								provider: host.provider ?? null,
								configSummary: decryptedHostConfigSummary(normalizedConfig),
							},
						});
						return c.json({
							ok: true,
							payload: {
								id: session.id,
								hostKind: session.hostKind,
								hostId: session.hostId,
								purpose: session.purpose,
								expiresAt: session.expiresAt,
							},
						}, { status: 201 });
					} catch (error) {
						return jsonError(c, 500, 'Provider credentials were unlocked, but the launch credential session could not be created.', {
							message: error instanceof Error ? error.message : String(error),
							hostKind,
							hostId,
						});
					}
				});
	
	app.post('/v1/teams/:teamId/hosting-audit', async (c) => {
					const body = await c.req.json().catch(() => ({}));
					const repair = body.repair === true;
					const access = await requireTeamAccess(c, store, c.req.param('teamId'), repair ? 'teams:manage:team' : 'projects:read:team');
					if (access.response) return access.response;
					const teamId = c.req.param('teamId');
					const hostKinds = normalizeAuditHostKinds(body.hostKinds);
					try {
						const credentialOverlay = await collectHostingAuditCredentialOverlay({
							store,
							runtime,
							teamId,
							hostKinds,
							credentialSessions: body.credentialSessions && typeof body.credentialSessions === 'object' ? body.credentialSessions : {},
						});
						const report = await runTreeseedHostingAudit({
							tenantRoot: runtime?.resolved?.config?.repoRoot ?? process.cwd(),
							environment: ['current', 'local', 'staging', 'prod'].includes(body.environment) ? body.environment : 'current',
							repair,
							hostKinds,
							env: process.env,
							valuesOverlay: credentialOverlay.overlay,
						});
						return c.json({
							ok: true,
							payload: {
								...report,
								credentialSessions: credentialOverlay.sessions,
							},
						});
					} catch (error) {
						return jsonError(c, 400, error instanceof Error ? error.message : String(error));
					}
				});
	
	app.get('/v1/teams/:teamId/hosts', async (c) => {
					const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'projects:read:team');
					if (access.response) return access.response;
					const teamId = c.req.param('teamId');
					return c.json({
						ok: true,
						payload: [
							...(await listTreeseedManagedHostsFromConfig(teamId, runtime)),
							...(await store.listTeamWebHosts(teamId)),
						],
					});
				});
	
	app.get('/v1/teams/:teamId/hosts/:hostId', async (c) => {
					const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'projects:read:team');
					if (access.response) return access.response;
					const host = await store.getTeamWebHost(c.req.param('teamId'), c.req.param('hostId'));
					if (!host) return jsonError(c, 404, `Unknown host "${c.req.param('hostId')}".`);
					return c.json({ ok: true, payload: host });
				});
	
	app.post('/v1/teams/:teamId/web-hosts', async (c) => {
					const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'teams:manage:team');
					if (access.response) return access.response;
					const body = await c.req.json().catch(() => ({}));
					if (!body.name) {
						return jsonError(c, 400, 'name is required.');
					}
					const plaintextCredentials = rejectPlaintextHostCredentialFields(c, body);
					if (plaintextCredentials) return plaintextCredentials;
					if ((body.ownership ?? 'team_owned') === 'team_owned' && !encryptedHostPayloadLooksValid(body.encryptedPayload)) {
						return jsonError(c, 400, 'A valid encryptedPayload is required for team-owned hosts.');
					}
					try {
						return c.json({
							ok: true,
							payload: await store.createTeamWebHost(c.req.param('teamId'), {
								...body,
								provider: typeof body.provider === 'string' ? body.provider : 'cloudflare',
								createdById: access.principal.id,
								updatedById: access.principal.id,
							}),
						}, { status: 201 });
					} catch (error) {
						return jsonError(c, 400, error instanceof Error ? error.message : String(error));
					}
				});
	
	app.post('/v1/teams/:teamId/hosts', async (c) => {
					const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'teams:manage:team');
					if (access.response) return access.response;
					const body = await c.req.json().catch(() => ({}));
					if (!body.name) {
						return jsonError(c, 400, 'name is required.');
					}
					const plaintextCredentials = rejectPlaintextHostCredentialFields(c, body);
					if (plaintextCredentials) return plaintextCredentials;
					if ((body.ownership ?? 'team_owned') === 'team_owned' && !encryptedHostPayloadLooksValid(body.encryptedPayload)) {
						return jsonError(c, 400, 'A valid encryptedPayload is required for team-owned hosts.');
					}
					try {
						return c.json({
							ok: true,
							payload: await store.createTeamWebHost(c.req.param('teamId'), {
								...body,
								provider: typeof body.provider === 'string' ? body.provider : 'cloudflare',
								createdById: access.principal.id,
								updatedById: access.principal.id,
							}),
						}, { status: 201 });
					} catch (error) {
						return jsonError(c, 400, error instanceof Error ? error.message : String(error));
					}
				});
	
	app.put('/v1/teams/:teamId/web-hosts/:hostId', async (c) => {
					const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'teams:manage:team');
					if (access.response) return access.response;
					const body = await c.req.json().catch(() => ({}));
					const plaintextCredentials = rejectPlaintextHostCredentialFields(c, body);
					if (plaintextCredentials) return plaintextCredentials;
					if (body.encryptedPayload !== undefined && !encryptedHostPayloadLooksValid(body.encryptedPayload)) {
						return jsonError(c, 400, 'encryptedPayload must be a valid encrypted host envelope.');
					}
					try {
						const payload = await store.updateTeamWebHost(c.req.param('teamId'), c.req.param('hostId'), {
							...body,
							updatedById: access.principal.id,
						});
						if (!payload) {
							return jsonError(c, 404, 'Unknown web host.');
						}
						return c.json({ ok: true, payload });
					} catch (error) {
						return jsonError(c, 400, error instanceof Error ? error.message : String(error));
					}
				});
	
	app.put('/v1/teams/:teamId/hosts/:hostId', async (c) => {
					const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'teams:manage:team');
					if (access.response) return access.response;
					const body = await c.req.json().catch(() => ({}));
					const plaintextCredentials = rejectPlaintextHostCredentialFields(c, body);
					if (plaintextCredentials) return plaintextCredentials;
					if (body.encryptedPayload !== undefined && !encryptedHostPayloadLooksValid(body.encryptedPayload)) {
						return jsonError(c, 400, 'encryptedPayload must be a valid encrypted host envelope.');
					}
					try {
						const payload = await store.updateTeamWebHost(c.req.param('teamId'), c.req.param('hostId'), {
							...body,
							updatedById: access.principal.id,
						});
						if (!payload) {
							return jsonError(c, 404, 'Unknown host.');
						}
						return c.json({ ok: true, payload });
					} catch (error) {
						return jsonError(c, 400, error instanceof Error ? error.message : String(error));
					}
				});
	
	app.delete('/v1/teams/:teamId/web-hosts/:hostId', async (c) => {
					const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'teams:manage:team');
					if (access.response) return access.response;
					const result = await store.deleteTeamWebHost(c.req.param('teamId'), c.req.param('hostId'));
					return c.json(result, result.ok ? 200 : result.error === 'in_use' ? 409 : 404);
				});
	
	app.delete('/v1/teams/:teamId/hosts/:hostId', async (c) => {
					const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'teams:manage:team');
					if (access.response) return access.response;
					const result = await store.deleteTeamWebHost(c.req.param('teamId'), c.req.param('hostId'));
					return c.json(result, result.ok ? 200 : result.error === 'in_use' ? 409 : 404);
				});
	
	app.post('/v1/teams/:teamId/web-hosts/:hostId/validate', async (c) => {
					const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'projects:manage:team');
					if (access.response) return access.response;
					const host = await store.getTeamWebHost(c.req.param('teamId'), c.req.param('hostId'));
					if (!host) {
						return jsonError(c, 404, 'Unknown web host.');
					}
					const body = await c.req.json().catch(() => ({}));
					if (host.ownership === 'team_owned' && (!body.decryptedConfig || typeof body.decryptedConfig !== 'object')) {
						return jsonError(c, 400, 'decryptedConfig is required to validate a team-owned host.');
					}
					const validation = await validateTeamHostCredentialPayload(host, body.decryptedConfig);
					const validated = await store.updateTeamWebHost(c.req.param('teamId'), c.req.param('hostId'), {
						metadata: {
							...(host.metadata ?? {}),
							lastValidation: validation,
						},
						updatedById: access.principal.id,
					});
					return c.json({
						ok: true,
						payload: {
							host: validated,
							validation: validated?.metadata?.lastValidation ?? null,
						},
					});
				});
	
	app.post('/v1/teams/:teamId/hosts/:hostId/validate', async (c) => {
					const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'projects:manage:team');
					if (access.response) return access.response;
					const host = await store.getTeamWebHost(c.req.param('teamId'), c.req.param('hostId'));
					if (!host) {
						return jsonError(c, 404, 'Unknown host.');
					}
					const body = await c.req.json().catch(() => ({}));
					if (host.ownership === 'team_owned' && (!body.decryptedConfig || typeof body.decryptedConfig !== 'object')) {
						return jsonError(c, 400, 'decryptedConfig is required to validate a team-owned host.');
					}
					const validation = await validateTeamHostCredentialPayload(host, body.decryptedConfig);
					const validated = await store.updateTeamWebHost(c.req.param('teamId'), c.req.param('hostId'), {
						metadata: {
							...(host.metadata ?? {}),
							lastValidation: validation,
						},
						updatedById: access.principal.id,
					});
					return c.json({
						ok: true,
						payload: {
							host: validated,
							validation: validated?.metadata?.lastValidation ?? null,
						},
					});
				});
}
