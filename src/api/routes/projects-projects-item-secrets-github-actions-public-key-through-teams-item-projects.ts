export function installProjectsProjectsItemSecretsGithubActionsPublicKeyThroughTeamsItemProjectsRoutes(context: any) {
	const { AGENT_PROMOTION_APPROVAL_DECISIONS, AGENT_TASK_SIGNATURES, AUTH_PROVIDERS, AgentSdk, CHECKOUT_COMMERCIAL_OFFER_MODES, CHECKOUT_OFFER_MODES, CHECKOUT_SUBSCRIPTION_OFFER_MODES, DatabaseAuthProvider, FEEDBACK_SCREENSHOT_TYPES, FEEDBACK_TYPES, GITHUB_ACTIONS_OIDC_ISSUER, HOST_KIND_SESSION_KEYS, LOCAL_CONTENT_COLLECTIONS, LOCAL_CONTENT_DEFAULTS, LOCAL_DECISION_TYPE_VALUES, LOCAL_WORK_CONTENT_COLLECTIONS, MARKET_EMAIL_CONFIRMATION_PREFIX, MAX_FEEDBACK_MESSAGE_LENGTH, MAX_FEEDBACK_SCREENSHOT_BYTES, MarketControlPlaneStore, NOTIFICATION_CONTENT_CAPABILITIES, PERSONAL_THEME_COMPILER_VERSION, PLAINTEXT_HOST_CREDENTIAL_FIELD_NAMES, PLATFORM_OPERATION_SCOPES, POSTGRES_AUTH_PROVIDER_ID, PROPOSAL_VERDICT_DECISION_TYPES, RemoteTreeseedClient, RemoteTreeseedOperationsClient, RemoteTreeseedSdkClient, SENSITIVE_QUERY_PARAM_PATTERN, STRIPE_PRICE_MIRROR_OFFER_MODES, STRIPE_PRODUCT_MIRROR_OFFER_MODES, TreeseedOperationsSdk, accountDeletionBlockers, accountDeletionConfirmationMatches, addRelationValue, apiDatabaseUrl, app, appendLaunchDeploymentEvent, appendLaunchPhaseProjection, appendProjectDeletionProgress, applyCommerceRefundState, applyContentPublishResult, applyHubLaunchFailure, applyHubLaunchResult, applySeedWithStore, artifactDownloadPayload, authConfig, authEmailDeliveryFailureDetail, authEmailDeliveryFailureReason, authProviderId, authTokenTimestampMillis, authTokenTimestampSeconds, availabilityAttempts, availabilityRateLimit, backfillUserEmailAddresses, base64Url, base64urlJson, bearerTokenFromRequest, buildCommerceCheckoutMetadata, buildCommerceStripeMetadata, buildGovernanceApprovalProjection, buildGovernanceProjection, buildInfrastructureProjection, buildKnowledgeArtifactProjection, buildKnowledgeProjection, buildLaunchCredentialOverlay, buildWorkdayProjection, canSkipCloudflareCleanupAfterFailedLaunch, canonicalArchitectureTopology, capacity, centralMarketProfile, checkoutGroupKey, checkoutGroupKind, checkoutGroupStatus, ciOperationForAction, cleanFeedbackString, cloudflareDeletionAuthenticationMessage, cloudflareDnsDomainsForHostValidation, cloudflareErrorMessage, cloudflareProjectDeletionResourceNames, cloudflareRequestForLaunchPreflight, cloudflareRequestForProjectDeletion, collectHostingAuditCredentialOverlay, commerceCheckoutError, commerceErrorResponse, commerceStripeLookupKey, commerceStripePriceParams, commerceStripeProductParams, commerceStripeSyncContext, config, configuredAuthProviderId, confirmationUrlFor, consumeReauthentication, contentRelationPolicy, createApiApp, createApiExtension, createCapacityControlPlane, createCipheriv, createClientEncryptedEscrowService, createCommerceCheckoutRun, createCommerceCheckoutRunForServiceContract, createDecipheriv, createDecisionFromProposals, createGitHubActionsSecretEnclave, createGitHubAppAdapter, createHash, createHmac, createMarketEmailConfirmation, createMarketPostgresDatabase, createMarketWebSession, createOrResendUserEmailAddress, createProjectHostCredentialSessions, createProjectInternalClient, createPublicKey, createRelatedLocalContentRecord, createStripeConnectService, createTreeDxCredentialBridge, createTreeseedApiApp, createVerify, credentialSessionKey, credentialSessionSecret, db, decodeRouteParam, decorateJob, decoratePlatformOperation, decryptCredentialSessionPayload, decryptHostConfig, decryptTeamHostForLaunch, decryptedHostConfigSummary, defaultConfig, deleteCloudflareDnsRecordsForProject, deleteCloudflareProjectResources, deleteTeamCapacityAggregate, derivePlatformOperationNavigation, deriveProjectHostBindingsView, domainInZone, encryptCredentialSessionPayload, encryptedHostPayloadLooksValid, enqueueTreeDxProvisionOperation, ensureCommerceStripeCustomer, ensureMarketCredentialSchema, ensurePrincipal, entitlementRenewalStateFromSubscription, enumValue, exchangeProviderIdentity, executeInline, executeProjectApi, executeSdkOperation, existsSync, exportSeedWithStore, exposeAuthTokenForTests, fallbackRemoteCapability, findById, findDispatchCapability, getSiteAuthConfig, getUserEmailAddress, githubOidcJwksCache, githubRequestForProjectDeletion, grantCommerceEntitlementsForOrder, handleCommerceInvoiceWebhook, handleCommercePaymentIntentWebhook, handleCommerceSubscriptionWebhook, hasRecordedCloudflareRuntimeResources, hashMarketPassword, hostBindingRequiresUnlock, hostKindForBinding, hubRepositoryPolicies, inferZoneNameForDomain, installApiRequestLogger, installCapacityRoutes, installProjectDeploymentRoutes, isLocalAcceptanceServicePrincipal, isLoopbackUrl, isPlatformOperationTerminal, isTeamApiPrincipal, isValidPersonalThemeDraft, jsonError, jsonThrownError, launchCapabilityPreset, launchPlannerRepositoryTopology, listCloudflareNamedResources, listTreeseedManagedHostsFromConfig, listUserEmailAddresses, loadGitHubOidcJwks, loadInfrastructureSeedState, loadKnowledgeContentEntries, loadNotificationPreferences, loadProjectHostBindingContext, loadTemplateCatalog, localAcceptanceAdminToken, localAcceptanceAuthEnabled, localContentPath, localContentRoot, logRequests, managedCloudflareConfigMissing, markdownToPlainProjectSummary, marketAuthContext, marketEmailTokenHash, marketProfilesForTeams, mergeCapability, mergeStringConfig, mkdir, nonSecretLaunchJobInput, normalizeAppearancePreference, normalizeAuditHostKinds, normalizeBaseUrl, normalizeCheckoutQuantity, normalizeCiEnvironment, normalizeDomainName, normalizeEmail, normalizeLocalContentInput, normalizeMarketProfile, normalizeNotificationPreferences, normalizeProjectDomainInput, normalizeProjectLaunchHostBindings, normalizeProviderCredentialConfig, normalizeRelationArray, normalizeRepositoryContentInput, normalizeRepositoryRelationArray, normalizeRepositorySlug, normalizeSeedEnvironments, normalizeTemplateLaunchRequirements, normalizeTreeseedTemplateId, normalizeUsername, normalizedCloudflareKvNamespaceReference, operationTokenSecret, optionalTrimmedString, orderStatusFromPaymentGroup, parseBase64urlJson, parseBooleanEnvValue, parseJsonObject, parseYaml, passwordResetUrlFor, patchLaunchIntentForCredentialOverlay, paymentGroupStatusFromPaymentIntent, pbkdf2Sync, persistProjectHostBindingOperationMetadata, personalThemeFromRow, plaintextHostCredentialFieldPaths, planKnowledgeHubLaunch, planProjectHostBindingOperation, planSeedWithStore, platformOperationMutationError, principalCanManageCommerceProduct, principalHasGlobalPlatformRole, principalHasPermission, principalIsSeedAdmin, privateKnowledgeAuditPayload, processCommerceStripeWebhook, projectAllowedCiRepositories, projectApiConnection, projectAppHref, projectDeletionBlockerRows, projectDeletionConfirmationMatches, projectDeletionHostname, projectDeletionOperation, projectHostBindingMetadata, projectHostResponsePayload, providerConfigFor, providerCredentialValuesForAudit, providerJwksCache, publicPaymentGroups, randomBytes, randomUUID, readCapacityRequestObject, readFile, readJsonOrFormBody, readLocalContentRecord, recordContentNotificationEvent, recordFeedbackSubmission, recordPrivateKnowledgeAudit, redactCommerceOwnershipWorkflow, redactCommerceServiceRequestForBuyer, redactedRequestTarget, refreshCommercePaymentGroupState, refreshCommerceStripeAccount, rejectPlaintextHostCredentialFields, rejectProjectSecretUnlockMaterial, relative, remainingRefundableAmount, repositoryContentRelationPolicy, repositoryInventoryWithPlatform, requestClientIp, requestSessionMetadata, requireCatalogItemAccess, requireCommerceCapacityInquiryAccess, requireCommerceCapacityListingAccess, requireCommerceOfferAccess, requireCommerceProductAccess, requireCommerceVendorForStripe, requireConfiguredServiceCredential, requireConnectedProjectRuntime, requirePlatformRunner, requireProjectAccess, requireProjectRunner, requireSeedApplyAccess, requireSeedPlanAccess, requireSellerTeamAccess, requireServiceBuyerAccess, requireServiceParticipantAccess, requireServiceSellerAccess, requireTeamAccess, requireVendorOrderManager, resolve, resolveAgentArtifactBucket, resolveAgentTaskSignature, resolveApiConfig, resolveAuthApprovalBaseUrl, resolveCloudflareZoneForLaunchPreflight, resolveCommerceCheckoutItem, resolveFulfillmentArtifact, resolveLaunchTemplateRequirements, resolveOrderItemForRefund, resolvePlatformRepositoryDescriptor, resolvePlatformRunnerSecret, resolveProjectDeletionCloudflareZone, resolveProjectLaunchHostBindings, resolvePublicTreeDxTeam, resolveStripeEnvironment, resolveStripePublishableKey, resolveStripeWebhookSecret, resolveTreeseedManagedCloudflareHostConfigFromConfig, resolveUiProjectionContext, resourceRowsFromLaunch, retryApiLaunchBootstrapFromRequest, rm, runProjectDeletionApiDestroy, runProjectLaunchApiBootstrap, runTreeseedHostingAudit, runtime, runtimeMarketAuthProvider, runtimeProviders, safeFeedbackClient, safeFeedbackContext, safeFeedbackScreenshot, safePlatformOperationOutput, safePrivateKnowledgeSlug, safeTokenEquals, sanitizeLaunchResultForStorage, sanitizedReturnTo, scheduleBackgroundBootstrap, seedActor, seedCreatesMissingTeams, seedExistingTeamIds, selectDispatchTarget, sendAuthEmail, sendEmailConfirmation, sendTeamInviteEmail, sendWelcomeEmail, serializeFrontmatter, serializeUserEmailAddress, setPrimaryEmailAddress, sharedSdk, shouldBypassAcceptanceAuthEmailDelivery, shouldExposeNonProductionAuthDiagnostics, shouldLogApiRequests, signEditorialPreviewToken, signOperationToken, slugifyContent, slugifyRepositoryContent, sourceFromProjectDetails, store, stripeAccountMissingError, stripeAccountToConnectedAccountPatch, stripeClientSecret, stripeCommerceUrl, stripeConfiguredError, stripeConnectService, stripeMetadataValue, stripePriceTermsDrift, stripeRefundStatus, stripeTimestampToIso, stripeVendorApprovalError, subscriptionClientSecret, subscriptionStatusFromStripe, syncCommerceOfferStripeProduct, syncCommercePriceStripePrice, syncCommerceSubscriptionFromStripe, syncPrimaryEmailCaches, teamInviteAcceptUrlFor, timingSafeEqual, trimmedHeaderValue, uiRuntimeLocals, uniqueCloudflareKvNamespaceReferences, uniqueRelationArray, unknownKeys, unwrapLaunchOperationOutput, unwrapOperationPayload, updateCheckoutCompletionFromGroup, updateLaunchDeployments, validateCiRefForEnvironment, validateFeedbackAccess, validateMarketPassword, validateProjectSlug, validatePublicUsername, validateTeamHostCredentialPayload, verifiedEmailCount, verifyCloudflareDnsWriteForLaunch, verifyGitHubOidcToken, verifyMarketPassword, verifyOperationToken, verifyProviderIdToken, webAuthPayload, webSessionData, writeFile, writeLocalContentRecord, writeParsedLocalContentRecord, yamlLines, yamlScalar } = context;
	app.get('/v1/projects/:projectId/secrets/github-actions/public-key', async (c) => {
					const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:manage:team');
					if (access.response) return access.response;
					const enclave = createGitHubActionsSecretEnclave({
						store,
						config: runtime.resolved.config,
					});
					try {
						const payload = await enclave.fetchPublicKey({
							teamId: access.details.project.teamId,
							projectId: c.req.param('projectId'),
							installationId: c.req.query('installationId'),
							repository: c.req.query('repository'),
							scope: c.req.query('scope') ?? 'environment',
							environment: c.req.query('environment'),
							requester: { type: 'user', id: access.principal.id },
						});
						return c.json({ ok: true, payload });
					} catch (error) {
						return jsonThrownError(c, error);
					}
				});
	
	app.post('/v1/projects/:projectId/secrets/github-actions/deploy', async (c) => {
					const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:manage:team');
					if (access.response) return access.response;
					const body = await c.req.json().catch(() => ({}));
					const enclave = createGitHubActionsSecretEnclave({
						store,
						config: runtime.resolved.config,
					});
					try {
						const payload = await enclave.deployEncryptedSecret({
							...body,
							teamId: access.details.project.teamId,
							projectId: c.req.param('projectId'),
							requester: { type: 'user', id: access.principal.id },
						});
						return c.json({ ok: true, payload }, { status: 202 });
					} catch (error) {
						return jsonThrownError(c, error);
					}
				});
	
	app.get('/v1/projects/:projectId/secrets/escrow', async (c) => {
					const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:manage:team');
					if (access.response) return access.response;
					const service = createClientEncryptedEscrowService({ store });
					try {
						const payload = await service.list({
							teamId: access.details.project.teamId,
							projectId: c.req.param('projectId'),
							secretId: c.req.query('secretId'),
							status: c.req.query('status'),
							limit: c.req.query('limit'),
						});
						return c.json({ ok: true, payload });
					} catch (error) {
						return jsonThrownError(c, error);
					}
				});
	
	app.post('/v1/projects/:projectId/secrets/escrow', async (c) => {
					const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:manage:team');
					if (access.response) return access.response;
					const body = await c.req.json().catch(() => ({}));
					const service = createClientEncryptedEscrowService({ store });
					try {
						const payload = await service.create({
							...body,
							teamId: access.details.project.teamId,
							projectId: c.req.param('projectId'),
							requester: { type: 'user', id: access.principal.id },
						});
						return c.json({ ok: true, payload }, { status: 201 });
					} catch (error) {
						return jsonThrownError(c, error, 400);
					}
				});
	
	app.get('/v1/projects/:projectId/secrets/escrow/:escrowId', async (c) => {
					const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:manage:team');
					if (access.response) return access.response;
					const service = createClientEncryptedEscrowService({ store });
					try {
						const payload = await service.get({
							teamId: access.details.project.teamId,
							projectId: c.req.param('projectId'),
							escrowId: c.req.param('escrowId'),
						});
						return c.json({ ok: true, payload });
					} catch (error) {
						return jsonThrownError(c, error);
					}
				});
	
	app.patch('/v1/projects/:projectId/secrets/escrow/:escrowId', async (c) => {
					const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:manage:team');
					if (access.response) return access.response;
					const body = await c.req.json().catch(() => ({}));
					const service = createClientEncryptedEscrowService({ store });
					try {
						const payload = await service.update({
							...body,
							teamId: access.details.project.teamId,
							projectId: c.req.param('projectId'),
							escrowId: c.req.param('escrowId'),
							requester: { type: 'user', id: access.principal.id },
						});
						return c.json({ ok: true, payload });
					} catch (error) {
						return jsonThrownError(c, error);
					}
				});
	
	app.post('/v1/projects/:projectId/secrets/escrow/:escrowId/migrate', async (c) => {
					const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:manage:team');
					if (access.response) return access.response;
					const body = await c.req.json().catch(() => ({}));
					const service = createClientEncryptedEscrowService({ store });
					try {
						const payload = await service.migrate({
							...body,
							teamId: access.details.project.teamId,
							projectId: c.req.param('projectId'),
							escrowId: c.req.param('escrowId'),
							requester: { type: 'user', id: access.principal.id },
						});
						return c.json({ ok: true, payload });
					} catch (error) {
						return jsonThrownError(c, error);
					}
				});
	
	app.delete('/v1/projects/:projectId/secrets/escrow/:escrowId', async (c) => {
					const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:manage:team');
					if (access.response) return access.response;
					const service = createClientEncryptedEscrowService({ store });
					try {
						const payload = await service.tombstone({
							teamId: access.details.project.teamId,
							projectId: c.req.param('projectId'),
							escrowId: c.req.param('escrowId'),
							requester: { type: 'user', id: access.principal.id },
						});
						return c.json({ ok: true, payload });
					} catch (error) {
						return jsonThrownError(c, error);
					}
				});
	
	app.post('/v1/projects/:projectId/workflow-operations/:operationId/dispatch', async (c) => {
					const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:manage:team');
					if (access.response) return access.response;
					const body = await c.req.json().catch(() => ({}));
					const enclave = createGitHubActionsSecretEnclave({
						store,
						config: runtime.resolved.config,
					});
					try {
						const payload = await enclave.dispatchWorkflowOperation({
							...body,
							teamId: access.details.project.teamId,
							projectId: c.req.param('projectId'),
							operationId: c.req.param('operationId'),
							requester: { type: 'user', id: access.principal.id },
						});
						return c.json({ ok: true, payload }, { status: 202 });
					} catch (error) {
						return jsonThrownError(c, error);
					}
				});
	
	app.get('/v1/projects', async (c) => {
					const auth = await ensurePrincipal(c);
					if (auth.response) return auth.response;
					const teamId = typeof c.req.query('teamId') === 'string' ? c.req.query('teamId') : null;
					if (teamId) {
						const access = await requireTeamAccess(c, store, teamId, 'projects:read:team');
						if (access.response) return access.response;
						const projects = await store.listProjectsForPrincipal(auth.principal);
						return c.json({
							ok: true,
							payload: projects.filter((project) => project.teamId === teamId),
						});
					}
					return c.json({
						ok: true,
						payload: await store.listProjectsForPrincipal(auth.principal),
					});
				});
	
	app.post('/v1/teams/:teamId/projects/import', async (c) => {
					const requestedTeam = c.req.param('teamId');
					const team = await store.getTeam(requestedTeam).catch(() => null)
						?? await store.getTeamBySlug(requestedTeam).catch(() => null);
					if (!team) return jsonError(c, 404, 'Unknown team.', { code: 'team_not_found' });
					const access = await requireTeamAccess(c, store, team.id, 'projects:manage:team');
					if (access.response) return access.response;
					const body = await c.req.json().catch(() => ({}));
					try {
						const payload = await store.importProjectRepositoryPlan(team.id, body.plan ?? body);
						return c.json({ ok: true, payload }, { status: 201 });
					} catch (error) {
						return jsonError(c, 400, error instanceof Error ? error.message : 'Invalid project import plan.', {
							code: error?.code ?? 'invalid_project_import_plan',
						});
					}
				});
	
	app.post('/v1/teams/:teamId/projects', async (c) => {
					const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'projects:manage:team');
					if (access.response) return access.response;
					const body = await c.req.json().catch(() => ({}));
					if (!body.slug || !body.name) {
						return jsonError(c, 400, 'slug and name are required.');
					}
					let details;
					try {
						details = await store.createProject(c.req.param('teamId'), {
							id: typeof body.id === 'string' ? body.id : undefined,
							slug: String(body.slug),
							name: String(body.name),
							description: typeof body.description === 'string' ? body.description : null,
							metadata: typeof body.metadata === 'object' && body.metadata ? body.metadata : {},
							entitlementTier: typeof body.entitlementTier === 'string' ? body.entitlementTier : 'free',
						});
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						const status = /already in use/u.test(message) ? 409 : 400;
						return jsonError(c, status, message, { code: status === 409 ? 'slug_taken' : 'invalid_slug' });
					}
					return c.json({ ok: true, payload: details });
				});
}
