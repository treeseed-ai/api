export function installCommerceCapacityInquiriesProductVersionsAndOffersRoutes(context: any) {
	const { AGENT_PROMOTION_APPROVAL_DECISIONS, AGENT_TASK_SIGNATURES, AUTH_PROVIDERS, AgentSdk, CHECKOUT_COMMERCIAL_OFFER_MODES, CHECKOUT_OFFER_MODES, CHECKOUT_SUBSCRIPTION_OFFER_MODES, DatabaseAuthProvider, FEEDBACK_SCREENSHOT_TYPES, FEEDBACK_TYPES, GITHUB_ACTIONS_OIDC_ISSUER, HOST_KIND_SESSION_KEYS, LOCAL_CONTENT_COLLECTIONS, LOCAL_CONTENT_DEFAULTS, LOCAL_DECISION_TYPE_VALUES, LOCAL_WORK_CONTENT_COLLECTIONS, MARKET_EMAIL_CONFIRMATION_PREFIX, MAX_FEEDBACK_MESSAGE_LENGTH, MAX_FEEDBACK_SCREENSHOT_BYTES, MarketControlPlaneStore, NOTIFICATION_CONTENT_CAPABILITIES, PERSONAL_THEME_COMPILER_VERSION, PLAINTEXT_HOST_CREDENTIAL_FIELD_NAMES, PLATFORM_OPERATION_SCOPES, POSTGRES_AUTH_PROVIDER_ID, PROPOSAL_VERDICT_DECISION_TYPES, RemoteClient, RemoteOperationsClient, RemoteSdkClient, SENSITIVE_QUERY_PARAM_PATTERN, STRIPE_PRICE_MIRROR_OFFER_MODES, STRIPE_PRODUCT_MIRROR_OFFER_MODES, OperationsSdk, accountDeletionBlockers, accountDeletionConfirmationMatches, addRelationValue, apiDatabaseUrl, app, appendLaunchDeploymentEvent, appendLaunchPhaseProjection, appendProjectDeletionProgress, applyCommerceRefundState, applyContentPublishResult, applyHubLaunchFailure, applyHubLaunchResult, applySeedWithStore, artifactDownloadPayload, authConfig, authEmailDeliveryFailureDetail, authEmailDeliveryFailureReason, authProviderId, authTokenTimestampMillis, authTokenTimestampSeconds, availabilityAttempts, availabilityRateLimit, backfillUserEmailAddresses, base64Url, base64urlJson, bearerTokenFromRequest, buildCommerceCheckoutMetadata, buildCommerceStripeMetadata, buildGovernanceApprovalProjection, buildGovernanceProjection, buildInfrastructureProjection, buildKnowledgeArtifactProjection, buildKnowledgeProjection, buildLaunchCredentialOverlay, buildWorkdayProjection, canSkipCloudflareCleanupAfterFailedLaunch, canonicalArchitectureTopology, capacity, centralMarketProfile, checkoutGroupKey, checkoutGroupKind, checkoutGroupStatus, ciOperationForAction, cleanFeedbackString, cloudflareDeletionAuthenticationMessage, cloudflareDnsDomainsForHostValidation, cloudflareErrorMessage, cloudflareProjectDeletionResourceNames, cloudflareRequestForLaunchPreflight, cloudflareRequestForProjectDeletion, collectHostingAuditCredentialOverlay, commerceCheckoutError, commerceErrorResponse, commerceStripeLookupKey, commerceStripePriceParams, commerceStripeProductParams, commerceStripeSyncContext, config, configuredAuthProviderId, confirmationUrlFor, consumeReauthentication, contentRelationPolicy, createApiExtension, createCapacityControlPlane, createCipheriv, createClientEncryptedEscrowService, createCommerceCheckoutRun, createCommerceCheckoutRunForServiceContract, createDecipheriv, createDecisionFromProposals, createGitHubActionsSecretEnclave, createGitHubAppAdapter, createHash, createHmac, createMarketEmailConfirmation, createMarketPostgresDatabase, createMarketWebSession, createOrResendUserEmailAddress, createProjectHostCredentialSessions, createProjectInternalClient, createPublicKey, createRelatedLocalContentRecord, createStripeConnectService, createTreeDxCredentialBridge, createVerify, credentialSessionKey, credentialSessionSecret, db, decodeRouteParam, decorateJob, decoratePlatformOperation, decryptCredentialSessionPayload, decryptHostConfig, decryptTeamHostForLaunch, decryptedHostConfigSummary, defaultConfig, deleteCloudflareDnsRecordsForProject, deleteCloudflareProjectResources, deleteTeamCapacityAggregate, derivePlatformOperationNavigation, deriveProjectHostBindingsView, domainInZone, encryptCredentialSessionPayload, encryptedHostPayloadLooksValid, enqueueTreeDxProvisionOperation, ensureCommerceStripeCustomer, ensureMarketCredentialSchema, ensurePrincipal, entitlementRenewalStateFromSubscription, enumValue, exchangeProviderIdentity, executeInline, executeProjectApi, executeSdkOperation, existsSync, exportSeedWithStore, exposeAuthTokenForTests, fallbackRemoteCapability, findById, findDispatchCapability, getSiteAuthConfig, getUserEmailAddress, githubOidcJwksCache, githubRequestForProjectDeletion, grantCommerceEntitlementsForOrder, handleCommerceInvoiceWebhook, handleCommercePaymentIntentWebhook, handleCommerceSubscriptionWebhook, hasRecordedCloudflareRuntimeResources, hashMarketPassword, hostBindingRequiresUnlock, hostKindForBinding, hubRepositoryPolicies, inferZoneNameForDomain, installApiRequestLogger, installCapacityRoutes, installProjectDeploymentRoutes, isLocalAcceptanceServicePrincipal, isLoopbackUrl, isPlatformOperationTerminal, isTeamApiPrincipal, isValidPersonalThemeDraft, jsonError, jsonThrownError, launchCapabilityPreset, launchPlannerRepositoryTopology, listCloudflareNamedResources, listManagedHostsFromConfig, listUserEmailAddresses, loadGitHubOidcJwks, loadInfrastructureSeedState, loadKnowledgeContentEntries, loadNotificationPreferences, loadProjectHostBindingContext, loadTemplateCatalog, localAcceptanceAdminToken, localAcceptanceAuthEnabled, localContentPath, localContentRoot, logRequests, managedCloudflareConfigMissing, markdownToPlainProjectSummary, marketAuthContext, marketEmailTokenHash, marketProfilesForTeams, mergeCapability, mergeStringConfig, mkdir, nonSecretLaunchJobInput, normalizeAppearancePreference, normalizeAuditHostKinds, normalizeBaseUrl, normalizeCheckoutQuantity, normalizeCiEnvironment, normalizeDomainName, normalizeEmail, normalizeLocalContentInput, normalizeMarketProfile, normalizeNotificationPreferences, normalizeProjectDomainInput, normalizeProjectLaunchHostBindings, normalizeProviderCredentialConfig, normalizeRelationArray, normalizeRepositoryContentInput, normalizeRepositoryRelationArray, normalizeRepositorySlug, normalizeSeedEnvironments, normalizeTemplateLaunchRequirements, normalizeTemplateId, normalizeUsername, normalizedCloudflareKvNamespaceReference, operationTokenSecret, optionalTrimmedString, orderStatusFromPaymentGroup, parseBase64urlJson, parseBooleanEnvValue, parseJsonObject, parseYaml, passwordResetUrlFor, patchLaunchIntentForCredentialOverlay, paymentGroupStatusFromPaymentIntent, pbkdf2Sync, persistProjectHostBindingOperationMetadata, personalThemeFromRow, plaintextHostCredentialFieldPaths, planKnowledgeHubLaunch, planProjectHostBindingOperation, planSeedWithStore, platformOperationMutationError, principalCanManageCommerceProduct, principalHasGlobalPlatformRole, principalHasPermission, principalIsSeedAdmin, privateKnowledgeAuditPayload, processCommerceStripeWebhook, projectAllowedCiRepositories, projectApiConnection, projectAppHref, projectDeletionBlockerRows, projectDeletionConfirmationMatches, projectDeletionHostname, projectDeletionOperation, projectHostBindingMetadata, projectHostResponsePayload, providerConfigFor, providerCredentialValuesForAudit, providerJwksCache, publicPaymentGroups, randomBytes, randomUUID, readCapacityRequestObject, readFile, readJsonOrFormBody, readLocalContentRecord, recordContentNotificationEvent, recordFeedbackSubmission, recordPrivateKnowledgeAudit, redactCommerceOwnershipWorkflow, redactCommerceServiceRequestForBuyer, redactedRequestTarget, refreshCommercePaymentGroupState, refreshCommerceStripeAccount, rejectPlaintextHostCredentialFields, rejectProjectSecretUnlockMaterial, relative, remainingRefundableAmount, repositoryContentRelationPolicy, repositoryInventoryWithPlatform, requestClientIp, requestSessionMetadata, requireCatalogItemAccess, requireCommerceCapacityInquiryAccess, requireCommerceCapacityListingAccess, requireCommerceOfferAccess, requireCommerceProductAccess, requireCommerceVendorForStripe, requireConfiguredServiceCredential, requireConnectedProjectRuntime, requirePlatformRunner, requireProjectAccess, requireProjectRunner, requireSeedApplyAccess, requireSeedPlanAccess, requireSellerTeamAccess, requireServiceBuyerAccess, requireServiceParticipantAccess, requireServiceSellerAccess, requireTeamAccess, requireVendorOrderManager, resolve, resolveAgentArtifactBucket, resolveAgentTaskSignature, resolveApiConfig, resolveAuthApprovalBaseUrl, resolveCloudflareZoneForLaunchPreflight, resolveCommerceCheckoutItem, resolveFulfillmentArtifact, resolveLaunchTemplateRequirements, resolveOrderItemForRefund, resolvePlatformRepositoryDescriptor, resolvePlatformRunnerSecret, resolveProjectDeletionCloudflareZone, resolveProjectLaunchHostBindings, resolvePublicTreeDxTeam, resolveStripeEnvironment, resolveStripePublishableKey, resolveStripeWebhookSecret, resolveManagedCloudflareHostConfigFromConfig, resolveUiProjectionContext, resourceRowsFromLaunch, retryApiLaunchBootstrapFromRequest, rm, runProjectDeletionApiDestroy, runProjectLaunchApiBootstrap, runHostingAudit, runtime, runtimeMarketAuthProvider, runtimeProviders, safeFeedbackClient, safeFeedbackContext, safeFeedbackScreenshot, safePlatformOperationOutput, safePrivateKnowledgeSlug, safeTokenEquals, sanitizeLaunchResultForStorage, sanitizedReturnTo, scheduleBackgroundBootstrap, seedActor, seedCreatesMissingTeams, seedExistingTeamIds, selectDispatchTarget, sendAuthEmail, sendEmailConfirmation, sendTeamInviteEmail, sendWelcomeEmail, serializeFrontmatter, serializeUserEmailAddress, setPrimaryEmailAddress, sharedSdk, shouldBypassAcceptanceAuthEmailDelivery, shouldExposeNonProductionAuthDiagnostics, shouldLogApiRequests, signEditorialPreviewToken, signOperationToken, slugifyContent, slugifyRepositoryContent, sourceFromProjectDetails, store, stripeAccountMissingError, stripeAccountToConnectedAccountPatch, stripeClientSecret, stripeCommerceUrl, stripeConfiguredError, stripeConnectService, stripeMetadataValue, stripePriceTermsDrift, stripeRefundStatus, stripeTimestampToIso, stripeVendorApprovalError, subscriptionClientSecret, subscriptionStatusFromStripe, syncCommerceOfferStripeProduct, syncCommercePriceStripePrice, syncCommerceSubscriptionFromStripe, syncPrimaryEmailCaches, teamInviteAcceptUrlFor, timingSafeEqual, trimmedHeaderValue, uiRuntimeLocals, uniqueCloudflareKvNamespaceReferences, uniqueRelationArray, unknownKeys, unwrapLaunchOperationOutput, unwrapOperationPayload, updateCheckoutCompletionFromGroup, updateLaunchDeployments, validateCiRefForEnvironment, validateFeedbackAccess, validateMarketPassword, validateProjectSlug, validatePublicUsername, validateTeamHostCredentialPayload, verifiedEmailCount, verifyCloudflareDnsWriteForLaunch, verifyGitHubOidcToken, verifyMarketPassword, verifyOperationToken, verifyProviderIdToken, webAuthPayload, webSessionData, writeFile, writeLocalContentRecord, writeParsedLocalContentRecord, yamlLines, yamlScalar } = context;
	app.post('/v1/commerce/capacity-listings/:listingId/suspend', async (c) => {
					const access = await requireCommerceCapacityListingAccess(c, store, c.req.param('listingId'), 'teams:manage:team');
					if (access.response) return access.response;
					if (!principalIsSeedAdmin(access.principal)) return jsonError(c, 403, 'Permission denied.', { permission: 'commerce:capacity:approve' });
					const body = await c.req.json().catch(() => ({}));
					try {
						return c.json({ ok: true, payload: await store.suspendCommerceCapacityListing(access.listing.id, {
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
	
	app.post('/v1/commerce/capacity-listings/:listingId/archive', async (c) => {
					const access = await requireCommerceCapacityListingAccess(c, store, c.req.param('listingId'), 'teams:manage:team');
					if (access.response) return access.response;
					const body = await c.req.json().catch(() => ({}));
					try {
						return c.json({ ok: true, payload: await store.archiveCommerceCapacityListing(access.listing.id, {
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
	
	app.post('/v1/commerce/capacity-listings/:listingId/inquiries', async (c) => {
					const auth = await ensurePrincipal(c);
					if (auth.response) return auth.response;
					const body = await c.req.json().catch(() => ({}));
					const buyerTeamId = optionalTrimmedString(body.buyerTeamId);
					if (buyerTeamId) {
						const access = await requireTeamAccess(c, store, buyerTeamId, 'projects:read:team');
						if (access.response) return access.response;
					}
					try {
						return c.json({ ok: true, payload: await store.createCommerceCapacityListingInquiry(auth.principal, c.req.param('listingId'), {
							buyerTeamId,
							requestedServiceType: optionalTrimmedString(body.requestedServiceType),
							requestedScope: optionalTrimmedString(body.requestedScope),
							dataAccessRequested: body.dataAccessRequested && typeof body.dataAccessRequested === 'object' ? body.dataAccessRequested : {},
							secretAccessRequested: body.secretAccessRequested && typeof body.secretAccessRequested === 'object' ? body.secretAccessRequested : {},
							relatedProjectId: optionalTrimmedString(body.relatedProjectId),
							relatedWorkdayId: optionalTrimmedString(body.relatedWorkdayId),
							metadata: body.metadata && typeof body.metadata === 'object' ? body.metadata : {},
							actorType: 'user',
							actorId: auth.principal.id ?? null,
						}) }, { status: 201 });
					} catch (error) {
						return commerceErrorResponse(c, error);
					}
				});
	
	app.get('/v1/commerce/capacity-listing-inquiries', async (c) => {
					const auth = await ensurePrincipal(c);
					if (auth.response) return auth.response;
					const sellerTeamId = optionalTrimmedString(c.req.query('sellerTeamId'));
					const buyerTeamId = optionalTrimmedString(c.req.query('buyerTeamId'));
					if (sellerTeamId && !principalIsSeedAdmin(auth.principal)) {
						const access = await requireTeamAccess(c, store, sellerTeamId, 'projects:read:team');
						if (access.response) return access.response;
					}
					if (buyerTeamId && !principalIsSeedAdmin(auth.principal)) {
						const access = await requireTeamAccess(c, store, buyerTeamId, 'projects:read:team');
						if (access.response) return access.response;
					}
					return c.json({ ok: true, payload: await store.listCommerceCapacityListingInquiries(auth.principal, {
						listingId: optionalTrimmedString(c.req.query('listingId')),
						productId: optionalTrimmedString(c.req.query('productId')),
						vendorId: optionalTrimmedString(c.req.query('vendorId')),
						sellerTeamId,
						buyerTeamId,
						buyerUserId: optionalTrimmedString(c.req.query('buyerUserId')) ?? (!sellerTeamId && !buyerTeamId && !principalIsSeedAdmin(auth.principal) ? auth.principal.id : null),
						status: optionalTrimmedString(c.req.query('status')),
					}) });
				});
	
	app.get('/v1/commerce/capacity-listing-inquiries/:inquiryId', async (c) => {
					const access = await requireCommerceCapacityInquiryAccess(c, store, c.req.param('inquiryId'));
					if (access.response) return access.response;
					return c.json({ ok: true, payload: access.inquiry });
				});
	
	app.post('/v1/commerce/capacity-listing-inquiries/:inquiryId/review', async (c) => {
					const access = await requireCommerceCapacityInquiryAccess(c, store, c.req.param('inquiryId'), 'teams:manage:team');
					if (access.response) return access.response;
					const sellerAccess = principalIsSeedAdmin(access.principal) ? { response: null } : await requireTeamAccess(c, store, access.inquiry.sellerTeamId, 'teams:manage:team');
					if (sellerAccess.response) return sellerAccess.response;
					const body = await c.req.json().catch(() => ({}));
					return c.json({ ok: true, payload: await store.markCommerceCapacityInquiryReviewing(access.inquiry.id, {
						reason: optionalTrimmedString(body.reason),
						evidence: body.evidence && typeof body.evidence === 'object' ? body.evidence : {},
						metadata: body.metadata && typeof body.metadata === 'object' ? body.metadata : undefined,
						actorType: principalIsSeedAdmin(access.principal) ? 'operator' : 'user',
						actorId: access.principal.id ?? null,
					}) });
				});
	
	app.post('/v1/commerce/capacity-listing-inquiries/:inquiryId/approve-for-scoping', async (c) => {
					const access = await requireCommerceCapacityInquiryAccess(c, store, c.req.param('inquiryId'), 'teams:manage:team');
					if (access.response) return access.response;
					const sellerAccess = principalIsSeedAdmin(access.principal) ? { response: null } : await requireTeamAccess(c, store, access.inquiry.sellerTeamId, 'teams:manage:team');
					if (sellerAccess.response) return sellerAccess.response;
					const body = await c.req.json().catch(() => ({}));
					return c.json({ ok: true, payload: await store.approveCommerceCapacityInquiryForScoping(access.inquiry.id, {
						reason: optionalTrimmedString(body.reason),
						evidence: body.evidence && typeof body.evidence === 'object' ? body.evidence : {},
						metadata: body.metadata && typeof body.metadata === 'object' ? body.metadata : undefined,
						actorType: principalIsSeedAdmin(access.principal) ? 'operator' : 'user',
						actorId: access.principal.id ?? null,
					}) });
				});
	
	app.post('/v1/commerce/capacity-listing-inquiries/:inquiryId/decline', async (c) => {
					const access = await requireCommerceCapacityInquiryAccess(c, store, c.req.param('inquiryId'), 'teams:manage:team');
					if (access.response) return access.response;
					const sellerAccess = principalIsSeedAdmin(access.principal) ? { response: null } : await requireTeamAccess(c, store, access.inquiry.sellerTeamId, 'teams:manage:team');
					if (sellerAccess.response) return sellerAccess.response;
					const body = await c.req.json().catch(() => ({}));
					return c.json({ ok: true, payload: await store.declineCommerceCapacityInquiry(access.inquiry.id, {
						reason: optionalTrimmedString(body.reason),
						evidence: body.evidence && typeof body.evidence === 'object' ? body.evidence : {},
						metadata: body.metadata && typeof body.metadata === 'object' ? body.metadata : undefined,
						actorType: principalIsSeedAdmin(access.principal) ? 'operator' : 'user',
						actorId: access.principal.id ?? null,
					}) });
				});
	
	app.post('/v1/commerce/capacity-listing-inquiries/:inquiryId/cancel', async (c) => {
					const access = await requireCommerceCapacityInquiryAccess(c, store, c.req.param('inquiryId'), 'projects:read:team');
					if (access.response) return access.response;
					const body = await c.req.json().catch(() => ({}));
					try {
						return c.json({ ok: true, payload: await store.cancelCommerceCapacityInquiry(access.inquiry.id, {
							reason: optionalTrimmedString(body.reason),
							evidence: body.evidence && typeof body.evidence === 'object' ? body.evidence : {},
							metadata: body.metadata && typeof body.metadata === 'object' ? body.metadata : undefined,
							actorType: principalIsSeedAdmin(access.principal) ? 'operator' : 'user',
							actorId: access.principal.id ?? null,
						}) });
					} catch (error) {
						return commerceErrorResponse(c, error);
					}
				});
	
	app.post('/v1/commerce/products/:productId/versions', async (c) => {
					const access = await requireCommerceProductAccess(c, store, c.req.param('productId'), 'teams:manage:team');
					if (access.response) return access.response;
					const body = await c.req.json().catch(() => ({}));
					try {
						return c.json({ ok: true, payload: await store.createCommerceProductVersion(access.product.id, body) });
					} catch (error) {
						return commerceErrorResponse(c, error);
					}
				});
	
	app.get('/v1/commerce/products/:productId/versions', async (c) => {
					const access = await requireCommerceProductAccess(c, store, c.req.param('productId'));
					if (access.response) return access.response;
					return c.json({ ok: true, payload: await store.listCommerceProductVersions(access.product.id) });
				});
	
	app.post('/v1/commerce/products/:productId/versions/:versionId/submit', async (c) => {
					const access = await requireCommerceProductAccess(c, store, c.req.param('productId'), 'teams:manage:team');
					if (access.response) return access.response;
					const body = await c.req.json().catch(() => ({}));
					return c.json({ ok: true, payload: await store.submitCommerceProductVersion(c.req.param('versionId'), {
						reason: optionalTrimmedString(body.reason),
						evidence: body.evidence && typeof body.evidence === 'object' ? body.evidence : {},
						actorType: 'user',
						actorId: access.principal.id ?? null,
					}) });
				});
	
	app.post('/v1/commerce/products/:productId/versions/:versionId/approve', async (c) => {
					const auth = await ensurePrincipal(c);
					if (auth.response) return auth.response;
					if (!principalIsSeedAdmin(auth.principal)) return jsonError(c, 403, 'Permission denied.', { permission: 'commerce:approve:global' });
					const body = await c.req.json().catch(() => ({}));
					try {
						return c.json({ ok: true, payload: await store.approveCommerceProductVersion(c.req.param('versionId'), {
							publishedAt: optionalTrimmedString(body.publishedAt),
							reason: optionalTrimmedString(body.reason),
							evidence: body.evidence && typeof body.evidence === 'object' ? body.evidence : {},
							actorType: 'operator',
							actorId: auth.principal.id ?? null,
						}) });
					} catch (error) {
						return commerceErrorResponse(c, error);
					}
				});
	
	app.post('/v1/commerce/offers', async (c) => {
					const body = await c.req.json().catch(() => ({}));
					const productId = optionalTrimmedString(body.productId);
					if (!productId) return jsonError(c, 400, 'productId is required.');
					const access = await requireCommerceProductAccess(c, store, productId, 'teams:manage:team');
					if (access.response) return access.response;
					try {
						return c.json({ ok: true, payload: await store.createCommerceOffer(body) });
					} catch (error) {
						return commerceErrorResponse(c, error);
					}
				});
	
	app.get('/v1/commerce/offers', async (c) => {
					return c.json({ ok: true, payload: await store.listCommerceOffers({
						productId: optionalTrimmedString(c.req.query('productId')),
						vendorId: optionalTrimmedString(c.req.query('vendorId')),
						sellerTeamId: optionalTrimmedString(c.req.query('sellerTeamId')),
						status: optionalTrimmedString(c.req.query('status')),
						mode: optionalTrimmedString(c.req.query('mode')),
					}) });
				});
	
	app.get('/v1/commerce/offers/:offerId', async (c) => {
					const access = await requireCommerceOfferAccess(c, store, c.req.param('offerId'));
					if (access.response) return access.response;
					return c.json({ ok: true, payload: access.offer });
				});
	
	app.patch('/v1/commerce/offers/:offerId', async (c) => {
					const access = await requireCommerceOfferAccess(c, store, c.req.param('offerId'), 'teams:manage:team');
					if (access.response) return access.response;
					const body = await c.req.json().catch(() => ({}));
					try {
						return c.json({ ok: true, payload: await store.updateCommerceOffer(access.offer.id, body) });
					} catch (error) {
						return commerceErrorResponse(c, error);
					}
				});
	
	app.post('/v1/commerce/offers/:offerId/submit', async (c) => {
					const access = await requireCommerceOfferAccess(c, store, c.req.param('offerId'), 'teams:manage:team');
					if (access.response) return access.response;
					const body = await c.req.json().catch(() => ({}));
					return c.json({ ok: true, payload: await store.submitCommerceOffer(access.offer.id, {
						reason: optionalTrimmedString(body.reason),
						evidence: body.evidence && typeof body.evidence === 'object' ? body.evidence : {},
						actorType: 'user',
						actorId: access.principal.id ?? null,
					}) });
				});
	
	app.post('/v1/commerce/offers/:offerId/approve', async (c) => {
					const auth = await ensurePrincipal(c);
					if (auth.response) return auth.response;
					if (!principalIsSeedAdmin(auth.principal)) return jsonError(c, 403, 'Permission denied.', { permission: 'commerce:approve:global' });
					const body = await c.req.json().catch(() => ({}));
					try {
						const offer = await store.approveCommerceOffer(c.req.param('offerId'), {
							reason: optionalTrimmedString(body.reason),
							evidence: body.evidence && typeof body.evidence === 'object' ? body.evidence : {},
							actorType: 'operator',
							actorId: auth.principal.id ?? null,
						});
						if (!offer) return jsonError(c, 404, `Unknown commerce offer "${c.req.param('offerId')}".`);
						const syncResult = await syncCommerceOfferStripeProduct({
							store,
							stripeConnectService,
							offer,
							actorType: 'operator',
							actorId: auth.principal.id ?? null,
						});
						const syncedOffer = syncResult.offer ?? offer;
						if (syncedOffer.activePriceId) {
							const activePrice = await store.getCommercePrice(syncedOffer.activePriceId);
							if (activePrice) {
								await syncCommercePriceStripePrice({
									store,
									stripeConnectService,
									price: activePrice,
									actorType: 'operator',
									actorId: auth.principal.id ?? null,
								});
							}
						}
						return c.json({ ok: true, payload: await store.getCommerceOffer(offer.id) });
					} catch (error) {
						return commerceErrorResponse(c, error);
					}
				});
	
	app.get('/v1/commerce/offers/:offerId/stripe/status', async (c) => {
					const access = await requireCommerceOfferAccess(c, store, c.req.param('offerId'), 'projects:read:team');
					if (access.response) return access.response;
					const prices = await store.listCommercePrices(access.offer.id);
					return c.json({
						ok: true,
						payload: {
							offer: access.offer,
							prices,
						},
					});
				});
	
	app.post('/v1/commerce/offers/:offerId/stripe/reconcile', async (c) => {
					const access = await requireCommerceOfferAccess(c, store, c.req.param('offerId'), 'teams:manage:team');
					if (access.response) return access.response;
					try {
						const result = await syncCommerceOfferStripeProduct({
							store,
							stripeConnectService,
							offer: access.offer,
							actorType: principalIsSeedAdmin(access.principal) ? 'operator' : 'user',
							actorId: access.principal.id ?? null,
							reconcile: true,
							throwOnBlocked: true,
						});
						return c.json({ ok: true, payload: result });
					} catch (error) {
						return commerceErrorResponse(c, error);
					}
				});
	
	app.post('/v1/commerce/offers/:offerId/prices', async (c) => {
					const access = await requireCommerceOfferAccess(c, store, c.req.param('offerId'), 'teams:manage:team');
					if (access.response) return access.response;
					const body = await c.req.json().catch(() => ({}));
					try {
						return c.json({ ok: true, payload: await store.createCommercePrice(access.offer.id, body) });
					} catch (error) {
						return commerceErrorResponse(c, error);
					}
				});
	
	app.get('/v1/commerce/offers/:offerId/prices', async (c) => {
					const access = await requireCommerceOfferAccess(c, store, c.req.param('offerId'));
					if (access.response) return access.response;
					return c.json({ ok: true, payload: await store.listCommercePrices(access.offer.id) });
				});
	
	app.post('/v1/commerce/prices/:priceId/activate', async (c) => {
					const auth = await ensurePrincipal(c);
					if (auth.response) return auth.response;
					const body = await c.req.json().catch(() => ({}));
					try {
						const existing = await store.getCommercePrice(c.req.param('priceId'));
						if (!existing) return jsonError(c, 404, `Unknown commerce price "${c.req.param('priceId')}".`);
						const offer = await store.getCommerceOffer(existing.offerId);
						const access = await requireTeamAccess(c, store, offer.sellerTeamId, 'teams:manage:team');
						if (access.response) return access.response;
						const price = await store.activateCommercePrice(c.req.param('priceId'), {
							reason: optionalTrimmedString(body.reason),
							evidence: body.evidence && typeof body.evidence === 'object' ? body.evidence : {},
							actorType: principalIsSeedAdmin(auth.principal) ? 'operator' : 'user',
							actorId: auth.principal.id ?? null,
						});
						const refreshedOffer = await store.getCommerceOffer(existing.offerId);
						if (refreshedOffer?.status === 'approved') {
							const syncResult = await syncCommercePriceStripePrice({
								store,
								stripeConnectService,
								price,
								actorType: principalIsSeedAdmin(auth.principal) ? 'operator' : 'user',
								actorId: auth.principal.id ?? null,
							});
							return c.json({ ok: true, payload: syncResult.price ?? price });
						}
						return c.json({ ok: true, payload: price });
					} catch (error) {
						return commerceErrorResponse(c, error);
					}
				});
}
