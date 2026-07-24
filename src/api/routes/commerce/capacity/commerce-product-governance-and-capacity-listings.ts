export function installCommerceProductGovernanceAndCapacityListingsRoutes(context: any) {
	const { AGENT_PROMOTION_APPROVAL_DECISIONS, AGENT_TASK_SIGNATURES, AUTH_PROVIDERS, AgentSdk, CHECKOUT_COMMERCIAL_OFFER_MODES, CHECKOUT_OFFER_MODES, CHECKOUT_SUBSCRIPTION_OFFER_MODES, DatabaseAuthProvider, FEEDBACK_SCREENSHOT_TYPES, FEEDBACK_TYPES, GITHUB_ACTIONS_OIDC_ISSUER, HOST_KIND_SESSION_KEYS, LOCAL_CONTENT_COLLECTIONS, LOCAL_CONTENT_DEFAULTS, LOCAL_DECISION_TYPE_VALUES, LOCAL_WORK_CONTENT_COLLECTIONS, MARKET_EMAIL_CONFIRMATION_PREFIX, MAX_FEEDBACK_MESSAGE_LENGTH, MAX_FEEDBACK_SCREENSHOT_BYTES, MarketControlPlaneStore, NOTIFICATION_CONTENT_CAPABILITIES, PERSONAL_THEME_COMPILER_VERSION, PLAINTEXT_HOST_CREDENTIAL_FIELD_NAMES, PLATFORM_OPERATION_SCOPES, POSTGRES_AUTH_PROVIDER_ID, PROPOSAL_VERDICT_DECISION_TYPES, RemoteClient, RemoteOperationsClient, RemoteSdkClient, SENSITIVE_QUERY_PARAM_PATTERN, STRIPE_PRICE_MIRROR_OFFER_MODES, STRIPE_PRODUCT_MIRROR_OFFER_MODES, OperationsSdk, accountDeletionBlockers, accountDeletionConfirmationMatches, addRelationValue, apiDatabaseUrl, app, appendLaunchDeploymentEvent, appendLaunchPhaseProjection, appendProjectDeletionProgress, applyCommerceRefundState, applyContentPublishResult, applyHubLaunchFailure, applyHubLaunchResult, applySeedWithStore, artifactDownloadPayload, authConfig, authEmailDeliveryFailureDetail, authEmailDeliveryFailureReason, authProviderId, authTokenTimestampMillis, authTokenTimestampSeconds, availabilityAttempts, availabilityRateLimit, backfillUserEmailAddresses, base64Url, base64urlJson, bearerTokenFromRequest, buildCommerceCheckoutMetadata, buildCommerceStripeMetadata, buildGovernanceApprovalProjection, buildGovernanceProjection, buildInfrastructureProjection, buildKnowledgeArtifactProjection, buildKnowledgeProjection, buildLaunchCredentialOverlay, buildWorkdayProjection, canSkipCloudflareCleanupAfterFailedLaunch, canonicalArchitectureTopology, capacity, centralMarketProfile, checkoutGroupKey, checkoutGroupKind, checkoutGroupStatus, ciOperationForAction, cleanFeedbackString, cloudflareDeletionAuthenticationMessage, cloudflareDnsDomainsForHostValidation, cloudflareErrorMessage, cloudflareProjectDeletionResourceNames, cloudflareRequestForLaunchPreflight, cloudflareRequestForProjectDeletion, collectHostingAuditCredentialOverlay, commerceCheckoutError, commerceErrorResponse, commerceStripeLookupKey, commerceStripePriceParams, commerceStripeProductParams, commerceStripeSyncContext, config, configuredAuthProviderId, confirmationUrlFor, consumeReauthentication, contentRelationPolicy, createApiExtension, createCapacityControlPlane, createCipheriv, createClientEncryptedEscrowService, createCommerceCheckoutRun, createCommerceCheckoutRunForServiceContract, createDecipheriv, createDecisionFromProposals, createGitHubActionsSecretEnclave, createGitHubAppAdapter, createHash, createHmac, createMarketEmailConfirmation, createMarketPostgresDatabase, createMarketWebSession, createOrResendUserEmailAddress, createProjectHostCredentialSessions, createProjectInternalClient, createPublicKey, createRelatedLocalContentRecord, createStripeConnectService, createTreeDxCredentialBridge, createVerify, credentialSessionKey, credentialSessionSecret, db, decodeRouteParam, decorateJob, decoratePlatformOperation, decryptCredentialSessionPayload, decryptHostConfig, decryptTeamHostForLaunch, decryptedHostConfigSummary, defaultConfig, deleteCloudflareDnsRecordsForProject, deleteCloudflareProjectResources, deleteTeamCapacityAggregate, derivePlatformOperationNavigation, deriveProjectHostBindingsView, domainInZone, encryptCredentialSessionPayload, encryptedHostPayloadLooksValid, enqueueTreeDxProvisionOperation, ensureCommerceStripeCustomer, ensureMarketCredentialSchema, ensurePrincipal, entitlementRenewalStateFromSubscription, enumValue, exchangeProviderIdentity, executeInline, executeProjectApi, executeSdkOperation, existsSync, exportSeedWithStore, exposeAuthTokenForTests, fallbackRemoteCapability, findById, findDispatchCapability, getSiteAuthConfig, getUserEmailAddress, githubOidcJwksCache, githubRequestForProjectDeletion, grantCommerceEntitlementsForOrder, handleCommerceInvoiceWebhook, handleCommercePaymentIntentWebhook, handleCommerceSubscriptionWebhook, hasRecordedCloudflareRuntimeResources, hashMarketPassword, hostBindingRequiresUnlock, hostKindForBinding, hubRepositoryPolicies, inferZoneNameForDomain, installApiRequestLogger, installCapacityRoutes, installProjectDeploymentRoutes, isLocalAcceptanceServicePrincipal, isLoopbackUrl, isPlatformOperationTerminal, isTeamApiPrincipal, isValidPersonalThemeDraft, jsonError, jsonThrownError, launchCapabilityPreset, launchPlannerRepositoryTopology, listCloudflareNamedResources, listManagedHostsFromConfig, listUserEmailAddresses, loadGitHubOidcJwks, loadInfrastructureSeedState, loadKnowledgeContentEntries, loadNotificationPreferences, loadProjectHostBindingContext, loadTemplateCatalog, localAcceptanceAdminToken, localAcceptanceAuthEnabled, localContentPath, localContentRoot, logRequests, managedCloudflareConfigMissing, markdownToPlainProjectSummary, marketAuthContext, marketEmailTokenHash, marketProfilesForTeams, mergeCapability, mergeStringConfig, mkdir, nonSecretLaunchJobInput, normalizeAppearancePreference, normalizeAuditHostKinds, normalizeBaseUrl, normalizeCheckoutQuantity, normalizeCiEnvironment, normalizeDomainName, normalizeEmail, normalizeLocalContentInput, normalizeMarketProfile, normalizeNotificationPreferences, normalizeProjectDomainInput, normalizeProjectLaunchHostBindings, normalizeProviderCredentialConfig, normalizeRelationArray, normalizeRepositoryContentInput, normalizeRepositoryRelationArray, normalizeRepositorySlug, normalizeSeedEnvironments, normalizeTemplateLaunchRequirements, normalizeTemplateId, normalizeUsername, normalizedCloudflareKvNamespaceReference, operationTokenSecret, optionalTrimmedString, orderStatusFromPaymentGroup, parseBase64urlJson, parseBooleanEnvValue, parseJsonObject, parseYaml, passwordResetUrlFor, patchLaunchIntentForCredentialOverlay, paymentGroupStatusFromPaymentIntent, pbkdf2Sync, persistProjectHostBindingOperationMetadata, personalThemeFromRow, plaintextHostCredentialFieldPaths, planKnowledgeHubLaunch, planProjectHostBindingOperation, planSeedWithStore, platformOperationMutationError, principalCanManageCommerceProduct, principalHasGlobalPlatformRole, principalHasPermission, principalIsSeedAdmin, privateKnowledgeAuditPayload, processCommerceStripeWebhook, projectAllowedCiRepositories, projectApiConnection, projectAppHref, projectDeletionBlockerRows, projectDeletionConfirmationMatches, projectDeletionHostname, projectDeletionOperation, projectHostBindingMetadata, projectHostResponsePayload, providerConfigFor, providerCredentialValuesForAudit, providerJwksCache, publicPaymentGroups, randomBytes, randomUUID, readCapacityRequestObject, readFile, readJsonOrFormBody, readLocalContentRecord, recordContentNotificationEvent, recordFeedbackSubmission, recordPrivateKnowledgeAudit, redactCommerceOwnershipWorkflow, redactCommerceServiceRequestForBuyer, redactedRequestTarget, refreshCommercePaymentGroupState, refreshCommerceStripeAccount, rejectPlaintextHostCredentialFields, rejectProjectSecretUnlockMaterial, relative, remainingRefundableAmount, repositoryContentRelationPolicy, repositoryInventoryWithPlatform, requestClientIp, requestSessionMetadata, requireCatalogItemAccess, requireCommerceCapacityInquiryAccess, requireCommerceCapacityListingAccess, requireCommerceOfferAccess, requireCommerceProductAccess, requireCommerceVendorForStripe, requireConfiguredServiceCredential, requireConnectedProjectRuntime, requirePlatformRunner, requireProjectAccess, requireProjectRunner, requireSeedApplyAccess, requireSeedPlanAccess, requireSellerTeamAccess, requireServiceBuyerAccess, requireServiceParticipantAccess, requireServiceSellerAccess, requireTeamAccess, requireVendorOrderManager, resolve, resolveAgentArtifactBucket, resolveAgentTaskSignature, resolveApiConfig, resolveAuthApprovalBaseUrl, resolveCloudflareZoneForLaunchPreflight, resolveCommerceCheckoutItem, resolveFulfillmentArtifact, resolveLaunchTemplateRequirements, resolveOrderItemForRefund, resolvePlatformRepositoryDescriptor, resolvePlatformRunnerSecret, resolveProjectDeletionCloudflareZone, resolveProjectLaunchHostBindings, resolvePublicTreeDxTeam, resolveStripeEnvironment, resolveStripePublishableKey, resolveStripeWebhookSecret, resolveManagedCloudflareHostConfigFromConfig, resolveUiProjectionContext, resourceRowsFromLaunch, retryApiLaunchBootstrapFromRequest, rm, runProjectDeletionApiDestroy, runProjectLaunchApiBootstrap, runHostingAudit, runtime, runtimeMarketAuthProvider, runtimeProviders, safeFeedbackClient, safeFeedbackContext, safeFeedbackScreenshot, safePlatformOperationOutput, safePrivateKnowledgeSlug, safeTokenEquals, sanitizeLaunchResultForStorage, sanitizedReturnTo, scheduleBackgroundBootstrap, seedActor, seedCreatesMissingTeams, seedExistingTeamIds, selectDispatchTarget, sendAuthEmail, sendEmailConfirmation, sendTeamInviteEmail, sendWelcomeEmail, serializeFrontmatter, serializeUserEmailAddress, setPrimaryEmailAddress, sharedSdk, shouldBypassAcceptanceAuthEmailDelivery, shouldExposeNonProductionAuthDiagnostics, shouldLogApiRequests, signEditorialPreviewToken, signOperationToken, slugifyContent, slugifyRepositoryContent, sourceFromProjectDetails, store, stripeAccountMissingError, stripeAccountToConnectedAccountPatch, stripeClientSecret, stripeCommerceUrl, stripeConfiguredError, stripeConnectService, stripeMetadataValue, stripePriceTermsDrift, stripeRefundStatus, stripeTimestampToIso, stripeVendorApprovalError, subscriptionClientSecret, subscriptionStatusFromStripe, syncCommerceOfferStripeProduct, syncCommercePriceStripePrice, syncCommerceSubscriptionFromStripe, syncPrimaryEmailCaches, teamInviteAcceptUrlFor, timingSafeEqual, trimmedHeaderValue, uiRuntimeLocals, uniqueCloudflareKvNamespaceReferences, uniqueRelationArray, unknownKeys, unwrapLaunchOperationOutput, unwrapOperationPayload, updateCheckoutCompletionFromGroup, updateLaunchDeployments, validateCiRefForEnvironment, validateFeedbackAccess, validateMarketPassword, validateProjectSlug, validatePublicUsername, validateTeamHostCredentialPayload, verifiedEmailCount, verifyCloudflareDnsWriteForLaunch, verifyGitHubOidcToken, verifyMarketPassword, verifyOperationToken, verifyProviderIdToken, webAuthPayload, webSessionData, writeFile, writeLocalContentRecord, writeParsedLocalContentRecord, yamlLines, yamlScalar } = context;
	app.get('/v1/commerce/products/:productId/ownership', async (c) => {
					const access = await requireCommerceProductAccess(c, store, c.req.param('productId'));
					if (access.response) return access.response;
					return c.json({ ok: true, payload: await store.listCommerceOwnershipRecords(access.product.id) });
				});
	
	app.patch('/v1/commerce/products/:productId/ownership/:ownershipRecordId', async (c) => {
					const access = await requireCommerceProductAccess(c, store, c.req.param('productId'), 'teams:manage:team');
					if (access.response) return access.response;
					const body = await c.req.json().catch(() => ({}));
					return c.json({ ok: true, payload: await store.updateCommerceOwnershipRecord(c.req.param('ownershipRecordId'), {
						publicSummary: body.publicSummary === undefined ? undefined : optionalTrimmedString(body.publicSummary),
						buyerVisible: body.buyerVisible,
						metadata: body.metadata && typeof body.metadata === 'object' ? body.metadata : undefined,
						reason: optionalTrimmedString(body.reason),
						evidence: body.evidence && typeof body.evidence === 'object' ? body.evidence : {},
						actorType: 'user',
						actorId: access.principal.id ?? null,
					}) });
				});
	
	app.post('/v1/commerce/products/:productId/stewards', async (c) => {
					const access = await requireCommerceProductAccess(c, store, c.req.param('productId'), 'teams:manage:team');
					if (access.response) return access.response;
					const body = await c.req.json().catch(() => ({}));
					try {
						return c.json({ ok: true, payload: await store.createCommerceStewardshipAssignment(access.product.id, body) });
					} catch (error) {
						return commerceErrorResponse(c, error);
					}
				});
	
	app.get('/v1/commerce/products/:productId/stewards', async (c) => {
					const access = await requireCommerceProductAccess(c, store, c.req.param('productId'));
					if (access.response) return access.response;
					return c.json({ ok: true, payload: await store.listCommerceStewardshipAssignments(access.product.id) });
				});
	
	app.patch('/v1/commerce/products/:productId/stewards/:assignmentId', async (c) => {
					const access = await requireCommerceProductAccess(c, store, c.req.param('productId'), 'teams:manage:team');
					if (access.response) return access.response;
					const body = await c.req.json().catch(() => ({}));
					return c.json({ ok: true, payload: await store.updateCommerceStewardshipAssignment(c.req.param('assignmentId'), {
						displayName: body.displayName === undefined ? undefined : optionalTrimmedString(body.displayName),
						responsibilities: body.responsibilities,
						visibleToBuyers: body.visibleToBuyers,
						endsAt: body.endsAt === undefined ? undefined : optionalTrimmedString(body.endsAt),
						metadata: body.metadata && typeof body.metadata === 'object' ? body.metadata : undefined,
						reason: optionalTrimmedString(body.reason),
						evidence: body.evidence && typeof body.evidence === 'object' ? body.evidence : {},
						actorType: 'user',
						actorId: access.principal.id ?? null,
					}) });
				});
	
	app.post('/v1/commerce/products/:productId/stewards/:assignmentId/end', async (c) => {
					const access = await requireCommerceProductAccess(c, store, c.req.param('productId'), 'teams:manage:team');
					if (access.response) return access.response;
					const body = await c.req.json().catch(() => ({}));
					return c.json({ ok: true, payload: await store.endCommerceStewardshipAssignment(c.req.param('assignmentId'), {
						endsAt: optionalTrimmedString(body.endsAt),
						reason: optionalTrimmedString(body.reason),
						evidence: body.evidence && typeof body.evidence === 'object' ? body.evidence : {},
						actorType: 'user',
						actorId: access.principal.id ?? null,
					}) });
				});
	
	app.post('/v1/commerce/products/:productId/contributions', async (c) => {
					const access = await requireCommerceProductAccess(c, store, c.req.param('productId'), 'teams:manage:team');
					if (access.response) return access.response;
					const body = await c.req.json().catch(() => ({}));
					return c.json({ ok: true, payload: await store.createCommerceContribution(access.product.id, body) });
				});
	
	app.get('/v1/commerce/products/:productId/contributions', async (c) => {
					const access = await requireCommerceProductAccess(c, store, c.req.param('productId'));
					if (access.response) return access.response;
					return c.json({ ok: true, payload: await store.listCommerceContributions(access.product.id) });
				});
	
	app.patch('/v1/commerce/products/:productId/contributions/:contributionId', async (c) => {
					const access = await requireCommerceProductAccess(c, store, c.req.param('productId'), 'teams:manage:team');
					if (access.response) return access.response;
					const body = await c.req.json().catch(() => ({}));
					return c.json({ ok: true, payload: await store.updateCommerceContribution(c.req.param('contributionId'), {
						summary: body.summary === undefined ? undefined : optionalTrimmedString(body.summary),
						attributionVisibility: optionalTrimmedString(body.attributionVisibility),
						benefitWeight: body.benefitWeight,
						metadata: body.metadata && typeof body.metadata === 'object' ? body.metadata : undefined,
						reason: optionalTrimmedString(body.reason),
						evidence: body.evidence && typeof body.evidence === 'object' ? body.evidence : {},
						actorType: 'user',
						actorId: access.principal.id ?? null,
					}) });
				});
	
	app.post('/v1/commerce/products/:productId/governance-policy', async (c) => {
					const access = await requireCommerceProductAccess(c, store, c.req.param('productId'), 'teams:manage:team');
					if (access.response) return access.response;
					const body = await c.req.json().catch(() => ({}));
					return c.json({ ok: true, payload: await store.createCommerceGovernancePolicy({
						...body,
						productId: access.product.id,
						teamId: access.product.sellerTeamId,
					}) });
				});
	
	app.get('/v1/commerce/products/:productId/governance-policy', async (c) => {
					const access = await requireCommerceProductAccess(c, store, c.req.param('productId'));
					if (access.response) return access.response;
					return c.json({ ok: true, payload: await store.listCommerceGovernancePolicies({ productId: access.product.id }) });
				});
	
	app.patch('/v1/commerce/products/:productId/governance-policy/:policyId', async (c) => {
					const access = await requireCommerceProductAccess(c, store, c.req.param('productId'), 'teams:manage:team');
					if (access.response) return access.response;
					const body = await c.req.json().catch(() => ({}));
					return c.json({ ok: true, payload: await store.updateCommerceGovernancePolicy(c.req.param('policyId'), {
						title: body.title === undefined ? undefined : optionalTrimmedString(body.title),
						approvalRules: body.approvalRules,
						quorumRules: body.quorumRules,
						buyerVisibleSummary: body.buyerVisibleSummary === undefined ? undefined : optionalTrimmedString(body.buyerVisibleSummary),
						status: optionalTrimmedString(body.status),
						reason: optionalTrimmedString(body.reason),
						evidence: body.evidence && typeof body.evidence === 'object' ? body.evidence : {},
						actorType: 'user',
						actorId: access.principal.id ?? null,
					}) });
				});
	
	app.post('/v1/commerce/products/:productId/ownership-transfer', async (c) => {
					const access = await requireCommerceProductAccess(c, store, c.req.param('productId'), 'teams:manage:team');
					if (access.response) return access.response;
					const body = await c.req.json().catch(() => ({}));
					return c.json({ ok: true, payload: await store.createCommerceOwnershipTransfer(access.product.id, {
						...body,
						actorType: 'user',
						actorId: access.principal.id ?? null,
						requestedByType: 'user',
						requestedById: access.principal.id ?? null,
					}) });
				});
	
	app.post('/v1/commerce/products/:productId/ownership-transfer/:transferId/submit', async (c) => {
					const access = await requireCommerceProductAccess(c, store, c.req.param('productId'), 'teams:manage:team');
					if (access.response) return access.response;
					const body = await c.req.json().catch(() => ({}));
					return c.json({ ok: true, payload: await store.submitCommerceOwnershipTransfer(c.req.param('transferId'), {
						reason: optionalTrimmedString(body.reason),
						evidence: body.evidence && typeof body.evidence === 'object' ? body.evidence : {},
						actorType: 'user',
						actorId: access.principal.id ?? null,
					}) });
				});
	
	app.post('/v1/commerce/products/:productId/ownership-transfer/:transferId/approve', async (c) => {
					const access = await requireCommerceProductAccess(c, store, c.req.param('productId'), 'teams:manage:team');
					if (access.response) return access.response;
					const body = await c.req.json().catch(() => ({}));
					return c.json({ ok: true, payload: await store.approveCommerceOwnershipTransfer(c.req.param('transferId'), {
						reason: optionalTrimmedString(body.reason),
						evidence: body.evidence && typeof body.evidence === 'object' ? body.evidence : {},
						actorType: 'user',
						actorId: access.principal.id ?? null,
					}) });
				});
	
	app.post('/v1/commerce/products/:productId/ownership-transfer/:transferId/reject', async (c) => {
					const access = await requireCommerceProductAccess(c, store, c.req.param('productId'), 'teams:manage:team');
					if (access.response) return access.response;
					const body = await c.req.json().catch(() => ({}));
					return c.json({ ok: true, payload: await store.rejectCommerceOwnershipTransfer(c.req.param('transferId'), {
						reason: optionalTrimmedString(body.reason),
						evidence: body.evidence && typeof body.evidence === 'object' ? body.evidence : {},
						actorType: 'user',
						actorId: access.principal.id ?? null,
					}) });
				});
	
	app.post('/v1/commerce/products/:productId/ownership-transfer/:transferId/cancel', async (c) => {
					const access = await requireCommerceProductAccess(c, store, c.req.param('productId'), 'teams:manage:team');
					if (access.response) return access.response;
					const body = await c.req.json().catch(() => ({}));
					return c.json({ ok: true, payload: await store.cancelCommerceOwnershipTransfer(c.req.param('transferId'), {
						reason: optionalTrimmedString(body.reason),
						evidence: body.evidence && typeof body.evidence === 'object' ? body.evidence : {},
						actorType: 'user',
						actorId: access.principal.id ?? null,
					}) });
				});
	
	app.post('/v1/commerce/products/:productId/succession-events', async (c) => {
					const access = await requireCommerceProductAccess(c, store, c.req.param('productId'), 'teams:manage:team');
					if (access.response) return access.response;
					const body = await c.req.json().catch(() => ({}));
					return c.json({ ok: true, payload: await store.createCommerceSuccessionEvent(access.product.id, {
						...body,
						actorType: 'user',
						actorId: access.principal.id ?? null,
						createdByType: 'user',
						createdById: access.principal.id ?? null,
					}) });
				});
	
	app.get('/v1/commerce/products/:productId/succession-events', async (c) => {
					const access = await requireCommerceProductAccess(c, store, c.req.param('productId'));
					if (access.response) return access.response;
					const canManage = await principalCanManageCommerceProduct(store, access.principal, access.product);
					const events = await store.listCommerceSuccessionEvents(access.product.id);
					return c.json({ ok: true, payload: canManage ? events : [] });
				});
	
	app.get('/v1/commerce/products/:productId/ownership-workflow', async (c) => {
					const access = await requireCommerceProductAccess(c, store, c.req.param('productId'));
					if (access.response) return access.response;
					const workflow = await store.getCommerceOwnershipWorkflowSummary(access.product.id);
					const canManage = await principalCanManageCommerceProduct(store, access.principal, access.product);
					return c.json({ ok: true, payload: canManage ? workflow : redactCommerceOwnershipWorkflow(workflow) });
				});
	
	app.get('/v1/commerce/marketplace', async (c) => {
					return c.json({
						ok: true,
						payload: await store.listCommerceMarketplaceProducts(c.get('principal'), {
							kind: optionalTrimmedString(c.req.query('kind')),
						}),
					});
				});
	
	app.get('/v1/commerce/marketplace/products/:productId', async (c) => {
					const product = await store.getCommerceMarketplaceProduct(c.req.param('productId'), c.get('principal'));
					if (!product) return jsonError(c, 404, `Unknown marketplace product "${c.req.param('productId')}".`);
					return c.json({ ok: true, payload: product });
				});
	
	app.get('/v1/commerce/capacity-listings', async (c) => {
					return c.json({
						ok: true,
						payload: await store.listCommerceCapacityListings(c.get('principal'), {
							productId: optionalTrimmedString(c.req.query('productId')),
							vendorId: optionalTrimmedString(c.req.query('vendorId')),
							sellerTeamId: optionalTrimmedString(c.req.query('sellerTeamId')),
							status: optionalTrimmedString(c.req.query('status')),
							accessLevel: optionalTrimmedString(c.req.query('accessLevel')),
						}),
					});
				});
	
	app.get('/v1/commerce/capacity-listings/:listingId', async (c) => {
					const access = await requireCommerceCapacityListingAccess(c, store, c.req.param('listingId'), null);
					if (access.response) return access.response;
					return c.json({ ok: true, payload: access.listing });
				});
	
	app.post('/v1/commerce/products/:productId/capacity-listing', async (c) => {
					const access = await requireCommerceProductAccess(c, store, c.req.param('productId'), 'teams:manage:team');
					if (access.response) return access.response;
					const body = await c.req.json().catch(() => ({}));
					try {
						const listing = await store.createCommerceCapacityListing(access.product.id, {
							capacityProviderId: optionalTrimmedString(body.capacityProviderId),
							executionProviderId: optionalTrimmedString(body.executionProviderId),
							accessLevel: optionalTrimmedString(body.accessLevel),
							runtimeIsolationLevel: optionalTrimmedString(body.runtimeIsolationLevel),
							humanInvolvementLevel: optionalTrimmedString(body.humanInvolvementLevel),
							aiInvolvementLevel: optionalTrimmedString(body.aiInvolvementLevel),
							dataAccessLevel: optionalTrimmedString(body.dataAccessLevel),
							secretAccessLevel: optionalTrimmedString(body.secretAccessLevel),
							supportedServiceTypes: Array.isArray(body.supportedServiceTypes) ? body.supportedServiceTypes : [],
							supportedRegions: Array.isArray(body.supportedRegions) ? body.supportedRegions : [],
							runtimeRequirements: body.runtimeRequirements && typeof body.runtimeRequirements === 'object' ? body.runtimeRequirements : {},
							dataHandlingSummary: optionalTrimmedString(body.dataHandlingSummary),
							buyerVisibleRiskSummary: optionalTrimmedString(body.buyerVisibleRiskSummary),
							governanceRequirements: body.governanceRequirements && typeof body.governanceRequirements === 'object' ? body.governanceRequirements : {},
							supportPolicy: optionalTrimmedString(body.supportPolicy),
							availabilitySummary: optionalTrimmedString(body.availabilitySummary),
							metadata: body.metadata && typeof body.metadata === 'object' ? body.metadata : {},
							marketAdmin: principalIsSeedAdmin(access.principal),
							actorType: principalIsSeedAdmin(access.principal) ? 'operator' : 'user',
							actorId: access.principal.id ?? null,
						}, capacity);
						return c.json({ ok: true, payload: listing }, { status: 201 });
					} catch (error) {
						return commerceErrorResponse(c, error);
					}
				});
	
	app.get('/v1/commerce/products/:productId/capacity-listing', async (c) => {
					const access = await requireCommerceProductAccess(c, store, c.req.param('productId'));
					if (access.response) return access.response;
					const canManage = await principalCanManageCommerceProduct(store, access.principal, access.product);
					const listing = await store.getCommerceCapacityListingForProduct(access.product.id, { publicSafe: !canManage });
					if (!listing) return jsonError(c, 404, `Unknown commerce capacity listing for product "${access.product.id}".`);
					if (!canManage && (listing.status !== 'approved' || listing.accessLevel !== 'public_summary')) return jsonError(c, 403, 'Permission denied.', { productId: access.product.id });
					return c.json({ ok: true, payload: listing });
				});
	
	app.patch('/v1/commerce/capacity-listings/:listingId', async (c) => {
					const access = await requireCommerceCapacityListingAccess(c, store, c.req.param('listingId'), 'teams:manage:team');
					if (access.response) return access.response;
					const body = await c.req.json().catch(() => ({}));
					try {
						return c.json({ ok: true, payload: await store.updateCommerceCapacityListing(access.listing.id, {
							capacityProviderId: body.capacityProviderId === undefined ? undefined : optionalTrimmedString(body.capacityProviderId),
							executionProviderId: body.executionProviderId === undefined ? undefined : optionalTrimmedString(body.executionProviderId),
							accessLevel: optionalTrimmedString(body.accessLevel),
							runtimeIsolationLevel: optionalTrimmedString(body.runtimeIsolationLevel),
							humanInvolvementLevel: optionalTrimmedString(body.humanInvolvementLevel),
							aiInvolvementLevel: optionalTrimmedString(body.aiInvolvementLevel),
							dataAccessLevel: optionalTrimmedString(body.dataAccessLevel),
							secretAccessLevel: optionalTrimmedString(body.secretAccessLevel),
							supportedServiceTypes: body.supportedServiceTypes,
							supportedRegions: body.supportedRegions,
							runtimeRequirements: body.runtimeRequirements,
							dataHandlingSummary: body.dataHandlingSummary === undefined ? undefined : optionalTrimmedString(body.dataHandlingSummary),
							buyerVisibleRiskSummary: body.buyerVisibleRiskSummary === undefined ? undefined : optionalTrimmedString(body.buyerVisibleRiskSummary),
							governanceRequirements: body.governanceRequirements,
							supportPolicy: body.supportPolicy === undefined ? undefined : optionalTrimmedString(body.supportPolicy),
							availabilitySummary: body.availabilitySummary === undefined ? undefined : optionalTrimmedString(body.availabilitySummary),
							metadata: body.metadata && typeof body.metadata === 'object' ? body.metadata : undefined,
							marketAdmin: principalIsSeedAdmin(access.principal),
							reason: optionalTrimmedString(body.reason),
							evidence: body.evidence && typeof body.evidence === 'object' ? body.evidence : {},
							actorType: principalIsSeedAdmin(access.principal) ? 'operator' : 'user',
							actorId: access.principal.id ?? null,
						}, capacity) });
					} catch (error) {
						return commerceErrorResponse(c, error);
					}
				});
	
	app.post('/v1/commerce/capacity-listings/:listingId/submit', async (c) => {
					const access = await requireCommerceCapacityListingAccess(c, store, c.req.param('listingId'), 'teams:manage:team');
					if (access.response) return access.response;
					const body = await c.req.json().catch(() => ({}));
					try {
						return c.json({ ok: true, payload: await store.submitCommerceCapacityListing(access.listing.id, {
							marketAdmin: principalIsSeedAdmin(access.principal),
							reason: optionalTrimmedString(body.reason),
							evidence: body.evidence && typeof body.evidence === 'object' ? body.evidence : {},
							actorType: principalIsSeedAdmin(access.principal) ? 'operator' : 'user',
							actorId: access.principal.id ?? null,
						}, capacity) });
					} catch (error) {
						return commerceErrorResponse(c, error);
					}
				});
	
	app.post('/v1/commerce/capacity-listings/:listingId/approve', async (c) => {
					const access = await requireCommerceCapacityListingAccess(c, store, c.req.param('listingId'), 'teams:manage:team');
					if (access.response) return access.response;
					if (!principalIsSeedAdmin(access.principal)) return jsonError(c, 403, 'Permission denied.', { permission: 'commerce:capacity:approve' });
					const body = await c.req.json().catch(() => ({}));
					try {
						return c.json({ ok: true, payload: await store.approveCommerceCapacityListing(access.listing.id, {
							marketAdmin: true,
							reason: optionalTrimmedString(body.reason),
							evidence: body.evidence && typeof body.evidence === 'object' ? body.evidence : {},
							actorType: 'operator',
							actorId: access.principal.id ?? null,
						}, capacity) });
					} catch (error) {
						return commerceErrorResponse(c, error);
					}
				});
	
	app.post('/v1/commerce/capacity-listings/:listingId/reject', async (c) => {
					const access = await requireCommerceCapacityListingAccess(c, store, c.req.param('listingId'), 'teams:manage:team');
					if (access.response) return access.response;
					if (!principalIsSeedAdmin(access.principal)) return jsonError(c, 403, 'Permission denied.', { permission: 'commerce:capacity:approve' });
					const body = await c.req.json().catch(() => ({}));
					try {
						return c.json({ ok: true, payload: await store.rejectCommerceCapacityListing(access.listing.id, {
							marketAdmin: true,
							reason: optionalTrimmedString(body.reason),
							evidence: body.evidence && typeof body.evidence === 'object' ? body.evidence : {},
							actorType: 'operator',
							actorId: access.principal.id ?? null,
						}, capacity) });
					} catch (error) {
						return commerceErrorResponse(c, error);
					}
				});
}
