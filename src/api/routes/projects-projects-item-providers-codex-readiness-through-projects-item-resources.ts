export function installProjectsProjectsItemProvidersCodexReadinessThroughProjectsItemResourcesRoutes(context: any) {
	const { AGENT_PROMOTION_APPROVAL_DECISIONS, AGENT_TASK_SIGNATURES, AUTH_PROVIDERS, AgentSdk, CHECKOUT_COMMERCIAL_OFFER_MODES, CHECKOUT_OFFER_MODES, CHECKOUT_SUBSCRIPTION_OFFER_MODES, DatabaseAuthProvider, FEEDBACK_SCREENSHOT_TYPES, FEEDBACK_TYPES, GITHUB_ACTIONS_OIDC_ISSUER, HOST_KIND_SESSION_KEYS, LOCAL_CONTENT_COLLECTIONS, LOCAL_CONTENT_DEFAULTS, LOCAL_DECISION_TYPE_VALUES, LOCAL_WORK_CONTENT_COLLECTIONS, MARKET_EMAIL_CONFIRMATION_PREFIX, MAX_FEEDBACK_MESSAGE_LENGTH, MAX_FEEDBACK_SCREENSHOT_BYTES, MarketControlPlaneStore, NOTIFICATION_CONTENT_CAPABILITIES, PERSONAL_THEME_COMPILER_VERSION, PLAINTEXT_HOST_CREDENTIAL_FIELD_NAMES, PLATFORM_OPERATION_SCOPES, POSTGRES_AUTH_PROVIDER_ID, PROPOSAL_VERDICT_DECISION_TYPES, RemoteTreeseedClient, RemoteTreeseedOperationsClient, RemoteTreeseedSdkClient, SENSITIVE_QUERY_PARAM_PATTERN, STRIPE_PRICE_MIRROR_OFFER_MODES, STRIPE_PRODUCT_MIRROR_OFFER_MODES, TreeseedOperationsSdk, accountDeletionBlockers, accountDeletionConfirmationMatches, addRelationValue, apiDatabaseUrl, app, appendLaunchDeploymentEvent, appendLaunchPhaseProjection, appendProjectDeletionProgress, applyCommerceRefundState, applyContentPublishResult, applyHubLaunchFailure, applyHubLaunchResult, applySeedWithStore, artifactDownloadPayload, authConfig, authEmailDeliveryFailureDetail, authEmailDeliveryFailureReason, authProviderId, authTokenTimestampMillis, authTokenTimestampSeconds, availabilityAttempts, availabilityRateLimit, backfillUserEmailAddresses, base64Url, base64urlJson, bearerTokenFromRequest, buildCommerceCheckoutMetadata, buildCommerceStripeMetadata, buildGovernanceApprovalProjection, buildGovernanceProjection, buildInfrastructureProjection, buildKnowledgeArtifactProjection, buildKnowledgeProjection, buildLaunchCredentialOverlay, buildWorkdayProjection, canSkipCloudflareCleanupAfterFailedLaunch, canonicalArchitectureTopology, capacity, centralMarketProfile, checkoutGroupKey, checkoutGroupKind, checkoutGroupStatus, ciOperationForAction, cleanFeedbackString, cloudflareDeletionAuthenticationMessage, cloudflareDnsDomainsForHostValidation, cloudflareErrorMessage, cloudflareProjectDeletionResourceNames, cloudflareRequestForLaunchPreflight, cloudflareRequestForProjectDeletion, collectHostingAuditCredentialOverlay, commerceCheckoutError, commerceErrorResponse, commerceStripeLookupKey, commerceStripePriceParams, commerceStripeProductParams, commerceStripeSyncContext, config, configuredAuthProviderId, confirmationUrlFor, consumeReauthentication, contentRelationPolicy, createApiApp, createApiExtension, createCapacityControlPlane, createCipheriv, createClientEncryptedEscrowService, createCommerceCheckoutRun, createCommerceCheckoutRunForServiceContract, createDecipheriv, createDecisionFromProposals, createGitHubActionsSecretEnclave, createGitHubAppAdapter, createHash, createHmac, createMarketEmailConfirmation, createMarketPostgresDatabase, createMarketWebSession, createOrResendUserEmailAddress, createProjectHostCredentialSessions, createProjectInternalClient, createPublicKey, createRelatedLocalContentRecord, createStripeConnectService, createTreeDxCredentialBridge, createTreeseedApiApp, createVerify, credentialSessionKey, credentialSessionSecret, db, decodeRouteParam, decorateJob, decoratePlatformOperation, decryptCredentialSessionPayload, decryptHostConfig, decryptTeamHostForLaunch, decryptedHostConfigSummary, defaultConfig, deleteCloudflareDnsRecordsForProject, deleteCloudflareProjectResources, deleteTeamCapacityAggregate, derivePlatformOperationNavigation, deriveProjectHostBindingsView, domainInZone, encryptCredentialSessionPayload, encryptedHostPayloadLooksValid, enqueueTreeDxProvisionOperation, ensureCommerceStripeCustomer, ensureMarketCredentialSchema, ensurePrincipal, entitlementRenewalStateFromSubscription, enumValue, exchangeProviderIdentity, executeInline, executeProjectApi, executeSdkOperation, existsSync, exportSeedWithStore, exposeAuthTokenForTests, fallbackRemoteCapability, findById, findDispatchCapability, getSiteAuthConfig, getUserEmailAddress, githubOidcJwksCache, githubRequestForProjectDeletion, grantCommerceEntitlementsForOrder, handleCommerceInvoiceWebhook, handleCommercePaymentIntentWebhook, handleCommerceSubscriptionWebhook, hasRecordedCloudflareRuntimeResources, hashMarketPassword, hostBindingRequiresUnlock, hostKindForBinding, hubRepositoryPolicies, inferZoneNameForDomain, installApiRequestLogger, installCapacityRoutes, installProjectDeploymentRoutes, isLocalAcceptanceServicePrincipal, isLoopbackUrl, isPlatformOperationTerminal, isTeamApiPrincipal, isValidPersonalThemeDraft, jsonError, jsonThrownError, launchCapabilityPreset, launchPlannerRepositoryTopology, listCloudflareNamedResources, listTreeseedManagedHostsFromConfig, listUserEmailAddresses, loadGitHubOidcJwks, loadInfrastructureSeedState, loadKnowledgeContentEntries, loadNotificationPreferences, loadProjectHostBindingContext, loadTemplateCatalog, localAcceptanceAdminToken, localAcceptanceAuthEnabled, localContentPath, localContentRoot, logRequests, managedCloudflareConfigMissing, markdownToPlainProjectSummary, marketAuthContext, marketEmailTokenHash, marketProfilesForTeams, mergeCapability, mergeStringConfig, mkdir, nonSecretLaunchJobInput, normalizeAppearancePreference, normalizeAuditHostKinds, normalizeBaseUrl, normalizeCheckoutQuantity, normalizeCiEnvironment, normalizeDomainName, normalizeEmail, normalizeLocalContentInput, normalizeMarketProfile, normalizeNotificationPreferences, normalizeProjectDomainInput, normalizeProjectLaunchHostBindings, normalizeProviderCredentialConfig, normalizeRelationArray, normalizeRepositoryContentInput, normalizeRepositoryRelationArray, normalizeRepositorySlug, normalizeSeedEnvironments, normalizeTemplateLaunchRequirements, normalizeTreeseedTemplateId, normalizeUsername, normalizedCloudflareKvNamespaceReference, operationTokenSecret, optionalTrimmedString, orderStatusFromPaymentGroup, parseBase64urlJson, parseBooleanEnvValue, parseJsonObject, parseYaml, passwordResetUrlFor, patchLaunchIntentForCredentialOverlay, paymentGroupStatusFromPaymentIntent, pbkdf2Sync, persistProjectHostBindingOperationMetadata, personalThemeFromRow, plaintextHostCredentialFieldPaths, planKnowledgeHubLaunch, planProjectHostBindingOperation, planSeedWithStore, platformOperationMutationError, principalCanManageCommerceProduct, principalHasGlobalPlatformRole, principalHasPermission, principalIsSeedAdmin, privateKnowledgeAuditPayload, processCommerceStripeWebhook, projectAllowedCiRepositories, projectApiConnection, projectAppHref, projectDeletionBlockerRows, projectDeletionConfirmationMatches, projectDeletionHostname, projectDeletionOperation, projectHostBindingMetadata, projectHostResponsePayload, providerConfigFor, providerCredentialValuesForAudit, providerJwksCache, publicPaymentGroups, randomBytes, randomUUID, readCapacityRequestObject, readFile, readJsonOrFormBody, readLocalContentRecord, recordContentNotificationEvent, recordFeedbackSubmission, recordPrivateKnowledgeAudit, redactCommerceOwnershipWorkflow, redactCommerceServiceRequestForBuyer, redactedRequestTarget, refreshCommercePaymentGroupState, refreshCommerceStripeAccount, rejectPlaintextHostCredentialFields, rejectProjectSecretUnlockMaterial, relative, remainingRefundableAmount, repositoryContentRelationPolicy, repositoryInventoryWithPlatform, requestClientIp, requestSessionMetadata, requireCatalogItemAccess, requireCommerceCapacityInquiryAccess, requireCommerceCapacityListingAccess, requireCommerceOfferAccess, requireCommerceProductAccess, requireCommerceVendorForStripe, requireConfiguredServiceCredential, requireConnectedProjectRuntime, requirePlatformRunner, requireProjectAccess, requireProjectRunner, requireSeedApplyAccess, requireSeedPlanAccess, requireSellerTeamAccess, requireServiceBuyerAccess, requireServiceParticipantAccess, requireServiceSellerAccess, requireTeamAccess, requireVendorOrderManager, resolve, resolveAgentArtifactBucket, resolveAgentTaskSignature, resolveApiConfig, resolveAuthApprovalBaseUrl, resolveCloudflareZoneForLaunchPreflight, resolveCommerceCheckoutItem, resolveFulfillmentArtifact, resolveLaunchTemplateRequirements, resolveOrderItemForRefund, resolvePlatformRepositoryDescriptor, resolvePlatformRunnerSecret, resolveProjectDeletionCloudflareZone, resolveProjectLaunchHostBindings, resolvePublicTreeDxTeam, resolveStripeEnvironment, resolveStripePublishableKey, resolveStripeWebhookSecret, resolveTreeseedManagedCloudflareHostConfigFromConfig, resolveUiProjectionContext, resourceRowsFromLaunch, retryApiLaunchBootstrapFromRequest, rm, runProjectDeletionApiDestroy, runProjectLaunchApiBootstrap, runTreeseedHostingAudit, runtime, runtimeMarketAuthProvider, runtimeProviders, safeFeedbackClient, safeFeedbackContext, safeFeedbackScreenshot, safePlatformOperationOutput, safePrivateKnowledgeSlug, safeTokenEquals, sanitizeLaunchResultForStorage, sanitizedReturnTo, scheduleBackgroundBootstrap, seedActor, seedCreatesMissingTeams, seedExistingTeamIds, selectDispatchTarget, sendAuthEmail, sendEmailConfirmation, sendTeamInviteEmail, sendWelcomeEmail, serializeFrontmatter, serializeUserEmailAddress, setPrimaryEmailAddress, sharedSdk, shouldBypassAcceptanceAuthEmailDelivery, shouldExposeNonProductionAuthDiagnostics, shouldLogApiRequests, signEditorialPreviewToken, signOperationToken, slugifyContent, slugifyRepositoryContent, sourceFromProjectDetails, store, stripeAccountMissingError, stripeAccountToConnectedAccountPatch, stripeClientSecret, stripeCommerceUrl, stripeConfiguredError, stripeConnectService, stripeMetadataValue, stripePriceTermsDrift, stripeRefundStatus, stripeTimestampToIso, stripeVendorApprovalError, subscriptionClientSecret, subscriptionStatusFromStripe, syncCommerceOfferStripeProduct, syncCommercePriceStripePrice, syncCommerceSubscriptionFromStripe, syncPrimaryEmailCaches, teamInviteAcceptUrlFor, timingSafeEqual, trimmedHeaderValue, uiRuntimeLocals, uniqueCloudflareKvNamespaceReferences, uniqueRelationArray, unknownKeys, unwrapLaunchOperationOutput, unwrapOperationPayload, updateCheckoutCompletionFromGroup, updateLaunchDeployments, validateCiRefForEnvironment, validateFeedbackAccess, validateMarketPassword, validateProjectSlug, validatePublicUsername, validateTeamHostCredentialPayload, verifiedEmailCount, verifyCloudflareDnsWriteForLaunch, verifyGitHubOidcToken, verifyMarketPassword, verifyOperationToken, verifyProviderIdToken, webAuthPayload, webSessionData, writeFile, writeLocalContentRecord, writeParsedLocalContentRecord, yamlLines, yamlScalar } = context;
	app.get('/v1/projects/:projectId/providers/codex/readiness', async (c) => {
					const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:read:team');
					if (access.response) return access.response;
					const payload = await store.requestProjectRuntime(access.details.project.id, access.principal, '/v1/providers/codex/readiness');
					return c.json({
						ok: true,
						payload: payload ?? {
							ok: false,
							providerSelected: false,
							sdkInstalled: false,
							nodeVersionOk: true,
							authDetected: false,
							subscriptionPlan: 'unknown',
							warnings: ['Project runtime is not connected or unavailable.'],
							blockingIssues: [],
						},
					});
				});
	
	app.post('/v1/projects/:projectId/share/export', async (c) => {
					const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:manage:team');
					if (access.response) return access.response;
					const body = await c.req.json().catch(() => ({}));
					const delegated = await requireConnectedProjectRuntime(c, store, access.details.project.id, access.principal, '/v1/share/export', {
						method: 'POST',
						body,
					});
					if (delegated.response) return delegated.response;
					return c.json({ ok: true, payload: delegated.payload });
				});
	
	app.post('/v1/projects/:projectId/share/package-template', async (c) => {
					const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:manage:team');
					if (access.response) return access.response;
					const body = await c.req.json().catch(() => ({}));
					const delegated = await requireConnectedProjectRuntime(c, store, access.details.project.id, access.principal, '/v1/share/package-template', {
						method: 'POST',
						body,
					});
					if (delegated.response) return delegated.response;
					return c.json({ ok: true, payload: delegated.payload });
				});
	
	app.post('/v1/projects/:projectId/share/package-knowledge-pack', async (c) => {
					const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:manage:team');
					if (access.response) return access.response;
					const body = await c.req.json().catch(() => ({}));
					const delegated = await requireConnectedProjectRuntime(c, store, access.details.project.id, access.principal, '/v1/share/package-knowledge-pack', {
						method: 'POST',
						body,
					});
					if (delegated.response) return delegated.response;
					return c.json({ ok: true, payload: delegated.payload });
				});
	
	app.post('/v1/projects/:projectId/share/publish', async (c) => {
					const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:manage:team');
					if (access.response) return access.response;
					const body = await c.req.json().catch(() => ({}));
					const href = await projectAppHref(store, access.details.project.teamId, access.details.project.slug, 'share');
					const job = await store.createJob({
						projectId: access.details.project.id,
						namespace: 'project',
						operation: 'publish_listing',
						status: 'waiting_for_approval',
						preferredMode: 'auto',
						selectedTarget: 'project_api',
						requestedByType: c.get('actorType') === 'service' ? 'service' : 'user',
						requestedById: typeof access.principal.id === 'string' ? access.principal.id : null,
						input: {
							actionPath: '/v1/share/publish',
							requestBody: body,
							teamId: access.details.project.teamId,
						},
					});
					await store.upsertTeamInboxItem(access.details.project.teamId, {
						id: `approval:${job.id}`,
						projectId: access.details.project.id,
						kind: 'approval',
						state: 'waiting_for_approval',
						title: `${access.details.project.name}: publish listing`,
						summary: 'A market listing is ready to publish and needs human approval.',
						href,
						itemKey: job.id,
						metadata: {
							jobId: job.id,
							action: 'publish_listing',
						},
					});
					return c.json({
						ok: true,
						payload: {
							job: decorateJob(normalizeBaseUrl(runtime.resolved.config.baseUrl ?? ''), job),
						},
					}, { status: 202 });
				});
	
	app.post('/v1/projects/:projectId/connection', async (c) => {
					const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:manage:team');
					if (access.response) return access.response;
					const body = await c.req.json().catch(() => ({}));
					const mode = enumValue(body.mode, ['hosted', 'hybrid', 'self_hosted'], body.mode == null ? access.details.connection?.mode ?? 'self_hosted' : null);
					if (!mode) return jsonError(c, 400, 'Invalid connection mode.');
					const executionOwner = enumValue(body.executionOwner, ['project_api', 'project_runner'], body.executionOwner == null ? access.details.connection?.executionOwner ?? 'project_runner' : null);
					if (!executionOwner) return jsonError(c, 400, 'Invalid execution owner.');
					const result = await store.upsertProjectConnection(c.req.param('projectId'), {
						mode,
						projectApiBaseUrl: optionalTrimmedString(body.projectApiBaseUrl),
						executionOwner,
						metadata: typeof body.metadata === 'object' && body.metadata ? body.metadata : {},
						rotateRunnerToken: body.rotateRunnerToken === true,
					});
					return c.json({
						ok: true,
						payload: {
							connection: result.connection,
							runnerToken: result.runnerToken,
						},
					});
				});
	
	app.get('/v1/projects/:projectId/hosting', async (c) => {
					const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:read:team');
					if (access.response) return access.response;
					return c.json({
						ok: true,
						payload: access.details.hosting,
					});
				});
	
	app.put('/v1/projects/:projectId/hosting', async (c) => {
					const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:manage:team');
					if (access.response) return access.response;
					const body = await c.req.json().catch(() => ({}));
					const kind = enumValue(body.kind, ['hosted_project', 'self_hosted_project']);
					if (!kind) return jsonError(c, 400, 'Invalid hosting kind.');
					const registration = enumValue(body.registration, ['none', 'optional', 'required'], 'none');
					const executionOwner = enumValue(body.executionOwner, ['project_api', 'project_runner'], null);
					if (body.executionOwner != null && !executionOwner) return jsonError(c, 400, 'Invalid execution owner.');
					const payload = await store.upsertProjectHosting(c.req.param('projectId'), {
						kind,
						registration,
						marketBaseUrl: optionalTrimmedString(body.marketBaseUrl),
						sourceRepoOwner: optionalTrimmedString(body.sourceRepoOwner),
						sourceRepoName: optionalTrimmedString(body.sourceRepoName),
						sourceRepoUrl: optionalTrimmedString(body.sourceRepoUrl),
						sourceRepoWorkflowPath: optionalTrimmedString(body.sourceRepoWorkflowPath),
						projectApiBaseUrl: optionalTrimmedString(body.projectApiBaseUrl),
						executionOwner,
						metadata: typeof body.metadata === 'object' && body.metadata ? body.metadata : {},
					});
					return c.json({ ok: true, payload });
				});
	
	app.get('/v1/projects/:projectId/environments', async (c) => {
					const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:read:team');
					if (access.response) return access.response;
					return c.json({
						ok: true,
						payload: await store.listProjectEnvironments(c.req.param('projectId')),
					});
				});
	
	app.put('/v1/projects/:projectId/environments/:environment', async (c) => {
					const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:manage:team');
					if (access.response) return access.response;
					const body = await c.req.json().catch(() => ({}));
					return c.json({
						ok: true,
						payload: await store.upsertProjectEnvironment(c.req.param('projectId'), {
							environment: c.req.param('environment'),
							deploymentProfile: typeof body.deploymentProfile === 'string' ? body.deploymentProfile : 'self_hosted_project',
							baseUrl: typeof body.baseUrl === 'string' ? body.baseUrl : null,
							cloudflareAccountId: typeof body.cloudflareAccountId === 'string' ? body.cloudflareAccountId : null,
							pagesProjectName: typeof body.pagesProjectName === 'string' ? body.pagesProjectName : null,
							workerName: typeof body.workerName === 'string' ? body.workerName : null,
							r2BucketName: typeof body.r2BucketName === 'string' ? body.r2BucketName : null,
							d1DatabaseName: typeof body.d1DatabaseName === 'string' ? body.d1DatabaseName : null,
							railwayProjectName: typeof body.railwayProjectName === 'string' ? body.railwayProjectName : null,
							metadata: typeof body.metadata === 'object' && body.metadata ? body.metadata : {},
						}),
					});
				});
	
	app.get('/v1/projects/:projectId/resources', async (c) => {
					const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:read:team');
					if (access.response) return access.response;
					const environment = typeof c.req.query('environment') === 'string' ? c.req.query('environment') : null;
					return c.json({
						ok: true,
						payload: await store.listProjectInfrastructureResources(c.req.param('projectId'), environment),
					});
				});
	
	app.post('/v1/projects/:projectId/resources', async (c) => {
					const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:manage:team');
					if (access.response) return access.response;
					const body = await c.req.json().catch(() => ({}));
					if (!body.environment || !body.provider || !body.resourceKind || !body.logicalName) {
						return jsonError(c, 400, 'environment, provider, resourceKind, and logicalName are required.');
					}
					return c.json({
						ok: true,
						payload: await store.upsertProjectInfrastructureResource(c.req.param('projectId'), {
							id: typeof body.id === 'string' ? body.id : undefined,
							environment: String(body.environment),
							provider: String(body.provider),
							resourceKind: String(body.resourceKind),
							logicalName: String(body.logicalName),
							locator: typeof body.locator === 'string' ? body.locator : null,
							metadata: typeof body.metadata === 'object' && body.metadata ? body.metadata : {},
						}),
					});
				});
}
