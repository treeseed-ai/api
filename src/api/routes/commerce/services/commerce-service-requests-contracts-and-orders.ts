export function installCommerceServiceRequestsContractsAndOrdersRoutes(context: any) {
	const { AGENT_PROMOTION_APPROVAL_DECISIONS, AGENT_TASK_SIGNATURES, AUTH_PROVIDERS, AgentSdk, CHECKOUT_COMMERCIAL_OFFER_MODES, CHECKOUT_OFFER_MODES, CHECKOUT_SUBSCRIPTION_OFFER_MODES, DatabaseAuthProvider, FEEDBACK_SCREENSHOT_TYPES, FEEDBACK_TYPES, GITHUB_ACTIONS_OIDC_ISSUER, HOST_KIND_SESSION_KEYS, LOCAL_CONTENT_COLLECTIONS, LOCAL_CONTENT_DEFAULTS, LOCAL_DECISION_TYPE_VALUES, LOCAL_WORK_CONTENT_COLLECTIONS, MARKET_EMAIL_CONFIRMATION_PREFIX, MAX_FEEDBACK_MESSAGE_LENGTH, MAX_FEEDBACK_SCREENSHOT_BYTES, MarketControlPlaneStore, NOTIFICATION_CONTENT_CAPABILITIES, PERSONAL_THEME_COMPILER_VERSION, PLAINTEXT_HOST_CREDENTIAL_FIELD_NAMES, PLATFORM_OPERATION_SCOPES, POSTGRES_AUTH_PROVIDER_ID, PROPOSAL_VERDICT_DECISION_TYPES, RemoteClient, RemoteOperationsClient, RemoteSdkClient, SENSITIVE_QUERY_PARAM_PATTERN, STRIPE_PRICE_MIRROR_OFFER_MODES, STRIPE_PRODUCT_MIRROR_OFFER_MODES, OperationsSdk, accountDeletionBlockers, accountDeletionConfirmationMatches, addRelationValue, apiDatabaseUrl, app, appendLaunchDeploymentEvent, appendLaunchPhaseProjection, appendProjectDeletionProgress, applyCommerceRefundState, applyContentPublishResult, applyHubLaunchFailure, applyHubLaunchResult, applySeedWithStore, artifactDownloadPayload, authConfig, authEmailDeliveryFailureDetail, authEmailDeliveryFailureReason, authProviderId, authTokenTimestampMillis, authTokenTimestampSeconds, availabilityAttempts, availabilityRateLimit, backfillUserEmailAddresses, base64Url, base64urlJson, bearerTokenFromRequest, buildCommerceCheckoutMetadata, buildCommerceStripeMetadata, buildGovernanceApprovalProjection, buildGovernanceProjection, buildInfrastructureProjection, buildKnowledgeArtifactProjection, buildKnowledgeProjection, buildLaunchCredentialOverlay, buildWorkdayProjection, canSkipCloudflareCleanupAfterFailedLaunch, canonicalArchitectureTopology, capacity, centralMarketProfile, checkoutGroupKey, checkoutGroupKind, checkoutGroupStatus, ciOperationForAction, cleanFeedbackString, cloudflareDeletionAuthenticationMessage, cloudflareDnsDomainsForHostValidation, cloudflareErrorMessage, cloudflareProjectDeletionResourceNames, cloudflareRequestForLaunchPreflight, cloudflareRequestForProjectDeletion, collectHostingAuditCredentialOverlay, commerceCheckoutError, commerceErrorResponse, commerceStripeLookupKey, commerceStripePriceParams, commerceStripeProductParams, commerceStripeSyncContext, config, configuredAuthProviderId, confirmationUrlFor, consumeReauthentication, contentRelationPolicy, createApiExtension, createCapacityControlPlane, createCipheriv, createClientEncryptedEscrowService, createCommerceCheckoutRun, createCommerceCheckoutRunForServiceContract, createDecipheriv, createDecisionFromProposals, createGitHubActionsSecretEnclave, createGitHubAppAdapter, createHash, createHmac, createMarketEmailConfirmation, createMarketPostgresDatabase, createMarketWebSession, createOrResendUserEmailAddress, createProjectHostCredentialSessions, createProjectInternalClient, createPublicKey, createRelatedLocalContentRecord, createStripeConnectService, createTreeDxCredentialBridge, createVerify, credentialSessionKey, credentialSessionSecret, db, decodeRouteParam, decorateJob, decoratePlatformOperation, decryptCredentialSessionPayload, decryptHostConfig, decryptTeamHostForLaunch, decryptedHostConfigSummary, defaultConfig, deleteCloudflareDnsRecordsForProject, deleteCloudflareProjectResources, deleteTeamCapacityAggregate, derivePlatformOperationNavigation, deriveProjectHostBindingsView, domainInZone, encryptCredentialSessionPayload, encryptedHostPayloadLooksValid, enqueueTreeDxProvisionOperation, ensureCommerceStripeCustomer, ensureMarketCredentialSchema, ensurePrincipal, entitlementRenewalStateFromSubscription, enumValue, exchangeProviderIdentity, executeInline, executeProjectApi, executeSdkOperation, existsSync, exportSeedWithStore, exposeAuthTokenForTests, fallbackRemoteCapability, findById, findDispatchCapability, getSiteAuthConfig, getUserEmailAddress, githubOidcJwksCache, githubRequestForProjectDeletion, grantCommerceEntitlementsForOrder, handleCommerceInvoiceWebhook, handleCommercePaymentIntentWebhook, handleCommerceSubscriptionWebhook, hasRecordedCloudflareRuntimeResources, hashMarketPassword, hostBindingRequiresUnlock, hostKindForBinding, hubRepositoryPolicies, inferZoneNameForDomain, installApiRequestLogger, installCapacityRoutes, installProjectDeploymentRoutes, isLocalAcceptanceServicePrincipal, isLoopbackUrl, isPlatformOperationTerminal, isTeamApiPrincipal, isValidPersonalThemeDraft, jsonError, jsonThrownError, launchCapabilityPreset, launchPlannerRepositoryTopology, listCloudflareNamedResources, listManagedHostsFromConfig, listUserEmailAddresses, loadGitHubOidcJwks, loadInfrastructureSeedState, loadKnowledgeContentEntries, loadNotificationPreferences, loadProjectHostBindingContext, loadTemplateCatalog, localAcceptanceAdminToken, localAcceptanceAuthEnabled, localContentPath, localContentRoot, logRequests, managedCloudflareConfigMissing, markdownToPlainProjectSummary, marketAuthContext, marketEmailTokenHash, marketProfilesForTeams, mergeCapability, mergeStringConfig, mkdir, nonSecretLaunchJobInput, normalizeAppearancePreference, normalizeAuditHostKinds, normalizeBaseUrl, normalizeCheckoutQuantity, normalizeCiEnvironment, normalizeDomainName, normalizeEmail, normalizeLocalContentInput, normalizeMarketProfile, normalizeNotificationPreferences, normalizeProjectDomainInput, normalizeProjectLaunchHostBindings, normalizeProviderCredentialConfig, normalizeRelationArray, normalizeRepositoryContentInput, normalizeRepositoryRelationArray, normalizeRepositorySlug, normalizeSeedEnvironments, normalizeTemplateLaunchRequirements, normalizeTemplateId, normalizeUsername, normalizedCloudflareKvNamespaceReference, operationTokenSecret, optionalTrimmedString, orderStatusFromPaymentGroup, parseBase64urlJson, parseBooleanEnvValue, parseJsonObject, parseYaml, passwordResetUrlFor, patchLaunchIntentForCredentialOverlay, paymentGroupStatusFromPaymentIntent, pbkdf2Sync, persistProjectHostBindingOperationMetadata, personalThemeFromRow, plaintextHostCredentialFieldPaths, planKnowledgeHubLaunch, planProjectHostBindingOperation, planSeedWithStore, platformOperationMutationError, principalCanManageCommerceProduct, principalHasGlobalPlatformRole, principalHasPermission, principalIsSeedAdmin, privateKnowledgeAuditPayload, processCommerceStripeWebhook, projectAllowedCiRepositories, projectApiConnection, projectAppHref, projectDeletionBlockerRows, projectDeletionConfirmationMatches, projectDeletionHostname, projectDeletionOperation, projectHostBindingMetadata, projectHostResponsePayload, providerConfigFor, providerCredentialValuesForAudit, providerJwksCache, publicPaymentGroups, randomBytes, randomUUID, readCapacityRequestObject, readFile, readJsonOrFormBody, readLocalContentRecord, recordContentNotificationEvent, recordFeedbackSubmission, recordPrivateKnowledgeAudit, redactCommerceOwnershipWorkflow, redactCommerceServiceRequestForBuyer, redactedRequestTarget, refreshCommercePaymentGroupState, refreshCommerceStripeAccount, rejectPlaintextHostCredentialFields, rejectProjectSecretUnlockMaterial, relative, remainingRefundableAmount, repositoryContentRelationPolicy, repositoryInventoryWithPlatform, requestClientIp, requestSessionMetadata, requireCatalogItemAccess, requireCommerceCapacityInquiryAccess, requireCommerceCapacityListingAccess, requireCommerceOfferAccess, requireCommerceProductAccess, requireCommerceVendorForStripe, requireConfiguredServiceCredential, requireConnectedProjectRuntime, requirePlatformRunner, requireProjectAccess, requireProjectRunner, requireSeedApplyAccess, requireSeedPlanAccess, requireSellerTeamAccess, requireServiceBuyerAccess, requireServiceParticipantAccess, requireServiceSellerAccess, requireTeamAccess, requireVendorOrderManager, resolve, resolveAgentArtifactBucket, resolveAgentTaskSignature, resolveApiConfig, resolveAuthApprovalBaseUrl, resolveCloudflareZoneForLaunchPreflight, resolveCommerceCheckoutItem, resolveFulfillmentArtifact, resolveLaunchTemplateRequirements, resolveOrderItemForRefund, resolvePlatformRepositoryDescriptor, resolvePlatformRunnerSecret, resolveProjectDeletionCloudflareZone, resolveProjectLaunchHostBindings, resolvePublicTreeDxTeam, resolveStripeEnvironment, resolveStripePublishableKey, resolveStripeWebhookSecret, resolveManagedCloudflareHostConfigFromConfig, resolveUiProjectionContext, resourceRowsFromLaunch, retryApiLaunchBootstrapFromRequest, rm, runProjectDeletionApiDestroy, runProjectLaunchApiBootstrap, runHostingAudit, runtime, runtimeMarketAuthProvider, runtimeProviders, safeFeedbackClient, safeFeedbackContext, safeFeedbackScreenshot, safePlatformOperationOutput, safePrivateKnowledgeSlug, safeTokenEquals, sanitizeLaunchResultForStorage, sanitizedReturnTo, scheduleBackgroundBootstrap, seedActor, seedCreatesMissingTeams, seedExistingTeamIds, selectDispatchTarget, sendAuthEmail, sendEmailConfirmation, sendTeamInviteEmail, sendWelcomeEmail, serializeFrontmatter, serializeUserEmailAddress, setPrimaryEmailAddress, sharedSdk, shouldBypassAcceptanceAuthEmailDelivery, shouldExposeNonProductionAuthDiagnostics, shouldLogApiRequests, signEditorialPreviewToken, signOperationToken, slugifyContent, slugifyRepositoryContent, sourceFromProjectDetails, store, stripeAccountMissingError, stripeAccountToConnectedAccountPatch, stripeClientSecret, stripeCommerceUrl, stripeConfiguredError, stripeConnectService, stripeMetadataValue, stripePriceTermsDrift, stripeRefundStatus, stripeTimestampToIso, stripeVendorApprovalError, subscriptionClientSecret, subscriptionStatusFromStripe, syncCommerceOfferStripeProduct, syncCommercePriceStripePrice, syncCommerceSubscriptionFromStripe, syncPrimaryEmailCaches, teamInviteAcceptUrlFor, timingSafeEqual, trimmedHeaderValue, uiRuntimeLocals, uniqueCloudflareKvNamespaceReferences, uniqueRelationArray, unknownKeys, unwrapLaunchOperationOutput, unwrapOperationPayload, updateCheckoutCompletionFromGroup, updateLaunchDeployments, validateCiRefForEnvironment, validateFeedbackAccess, validateMarketPassword, validateProjectSlug, validatePublicUsername, validateTeamHostCredentialPayload, verifiedEmailCount, verifyCloudflareDnsWriteForLaunch, verifyGitHubOidcToken, verifyMarketPassword, verifyOperationToken, verifyProviderIdToken, webAuthPayload, webSessionData, writeFile, writeLocalContentRecord, writeParsedLocalContentRecord, yamlLines, yamlScalar } = context;
	app.get('/v1/commerce/services/requests', async (c) => {
					const auth = await ensurePrincipal(c);
					if (auth.response) return auth.response;
					const sellerTeamId = optionalTrimmedString(c.req.query('sellerTeamId'));
					const buyerTeamId = optionalTrimmedString(c.req.query('buyerTeamId'));
					const filters: Record<string, unknown> = {
						sellerTeamId,
						buyerTeamId,
						status: optionalTrimmedString(c.req.query('status')),
						offerId: optionalTrimmedString(c.req.query('offerId')),
						relatedProjectId: optionalTrimmedString(c.req.query('relatedProjectId')),
						relatedWorkdayId: optionalTrimmedString(c.req.query('relatedWorkdayId')),
					};
					if (sellerTeamId && !principalIsSeedAdmin(auth.principal)) {
						const access = await requireTeamAccess(c, store, sellerTeamId, 'projects:read:team');
						if (access.response) return access.response;
					} else if (buyerTeamId && !principalIsSeedAdmin(auth.principal)) {
						const access = await requireTeamAccess(c, store, buyerTeamId, 'projects:read:team');
						if (access.response) return access.response;
					} else if (!principalIsSeedAdmin(auth.principal)) {
						filters.buyerUserId = auth.principal.id;
					}
					const requests = await store.listCommerceServiceRequests(auth.principal, filters);
					return c.json({ ok: true, payload: sellerTeamId ? requests : requests.map(redactCommerceServiceRequestForBuyer) });
				});
	
	app.get('/v1/commerce/services/requests/:requestId', async (c) => {
					const request = await store.getCommerceServiceRequest(c.req.param('requestId'));
					if (!request) return jsonError(c, 404, `Unknown commerce service request "${c.req.param('requestId')}".`);
					const access = await requireServiceParticipantAccess(c, store, request, 'projects:read:team');
					if (access.response) return access.response;
					const sellerAccess = principalIsSeedAdmin(access.principal)
						? { response: null }
						: await requireTeamAccess(c, store, request.sellerTeamId, 'projects:read:team');
					const sellerVisible = principalIsSeedAdmin(access.principal) || !sellerAccess.response;
					const quotes = await store.listCommerceServiceQuotes(request.id);
					const contract = request.contractId ? await store.getCommerceServiceContract(request.contractId) : null;
					const events = await store.listCommerceServiceEvents({ requestId: request.id });
					return c.json({
						ok: true,
						payload: {
							request: sellerVisible ? request : redactCommerceServiceRequestForBuyer(request),
							quotes,
							contract,
							events: sellerVisible ? events : events.map((event) => ({ ...event, evidence: {} })),
						},
					});
				});
	
	app.post('/v1/commerce/services/requests/:requestId/cancel', async (c) => {
					const request = await store.getCommerceServiceRequest(c.req.param('requestId'));
					if (!request) return jsonError(c, 404, `Unknown commerce service request "${c.req.param('requestId')}".`);
					const access = await requireServiceParticipantAccess(c, store, request, 'teams:manage:team');
					if (access.response) return access.response;
					if (['active', 'fulfilled'].includes(request.status)) return jsonError(c, 409, 'Active or fulfilled service requests cannot be canceled through request cancellation.');
					const body = await c.req.json().catch(() => ({}));
					const updated = await store.transitionCommerceServiceRequest(request.id, 'canceled', {
						eventType: 'canceled',
						action: 'commerce_service.canceled',
						reason: optionalTrimmedString(body.reason),
						evidence: body.evidence && typeof body.evidence === 'object' ? body.evidence : {},
						actorType: principalIsSeedAdmin(access.principal) ? 'operator' : 'user',
						actorId: access.principal.id ?? null,
					});
					return c.json({ ok: true, payload: updated });
				});
	
	app.post('/v1/commerce/services/requests/:requestId/scoping', async (c) => {
					const request = await store.getCommerceServiceRequest(c.req.param('requestId'));
					if (!request) return jsonError(c, 404, `Unknown commerce service request "${c.req.param('requestId')}".`);
					const access = await requireServiceSellerAccess(c, store, request, 'teams:manage:team');
					if (access.response) return access.response;
					const body = await c.req.json().catch(() => ({}));
					const updated = await store.updateCommerceServiceRequest(request.id, {
						status: 'scoping',
						approvedScope: optionalTrimmedString(body.approvedScope) ?? request.approvedScope,
						vendorPrivateNotes: optionalTrimmedString(body.vendorPrivateNotes) ?? request.vendorPrivateNotes,
						eventType: 'scoping_started',
						action: 'commerce_service.scoping_started',
						evidence: body.evidence && typeof body.evidence === 'object' ? body.evidence : {},
						actorType: principalIsSeedAdmin(access.principal) ? 'operator' : 'user',
						actorId: access.principal.id ?? null,
					});
					return c.json({ ok: true, payload: updated });
				});
	
	app.patch('/v1/commerce/services/requests/:requestId', async (c) => {
					const request = await store.getCommerceServiceRequest(c.req.param('requestId'));
					if (!request) return jsonError(c, 404, `Unknown commerce service request "${c.req.param('requestId')}".`);
					const access = await requireServiceSellerAccess(c, store, request, 'teams:manage:team');
					if (access.response) return access.response;
					const body = await c.req.json().catch(() => ({}));
					const updated = await store.updateCommerceServiceRequest(request.id, {
						approvedScope: body.approvedScope === undefined ? request.approvedScope : optionalTrimmedString(body.approvedScope),
						accessNeeds: body.accessNeeds && typeof body.accessNeeds === 'object' ? body.accessNeeds : request.accessNeeds,
						buyerVisibleSummary: body.buyerVisibleSummary === undefined ? request.buyerVisibleSummary : optionalTrimmedString(body.buyerVisibleSummary),
						vendorPrivateNotes: body.vendorPrivateNotes === undefined ? request.vendorPrivateNotes : optionalTrimmedString(body.vendorPrivateNotes),
						relatedProjectId: body.relatedProjectId === undefined ? request.relatedProjectId : optionalTrimmedString(body.relatedProjectId),
						relatedWorkdayId: body.relatedWorkdayId === undefined ? request.relatedWorkdayId : optionalTrimmedString(body.relatedWorkdayId),
						eventType: 'scope_updated',
						action: 'commerce_service.scope_updated',
						actorType: principalIsSeedAdmin(access.principal) ? 'operator' : 'user',
						actorId: access.principal.id ?? null,
					});
					return c.json({ ok: true, payload: updated });
				});
	
	app.post('/v1/commerce/services/requests/:requestId/quotes', async (c) => {
					const request = await store.getCommerceServiceRequest(c.req.param('requestId'));
					if (!request) return jsonError(c, 404, `Unknown commerce service request "${c.req.param('requestId')}".`);
					const access = await requireServiceSellerAccess(c, store, request, 'teams:manage:team');
					if (access.response) return access.response;
					const body = await c.req.json().catch(() => ({}));
					try {
						const quote = await store.createCommerceServiceQuote(request.id, {
							title: optionalTrimmedString(body.title),
							scopeSummary: optionalTrimmedString(body.scopeSummary),
							deliverables: Array.isArray(body.deliverables) ? body.deliverables : [],
							assumptions: Array.isArray(body.assumptions) ? body.assumptions : [],
							accessRequirements: body.accessRequirements && typeof body.accessRequirements === 'object' ? body.accessRequirements : {},
							governanceRequirements: body.governanceRequirements && typeof body.governanceRequirements === 'object' ? body.governanceRequirements : {},
							amount: body.amount,
							currency: optionalTrimmedString(body.currency),
							expiresAt: optionalTrimmedString(body.expiresAt),
							status: body.submit === true ? 'submitted' : 'draft',
							metadata: body.metadata && typeof body.metadata === 'object' ? body.metadata : {},
							actorType: principalIsSeedAdmin(access.principal) ? 'operator' : 'user',
							actorId: access.principal.id ?? null,
						}, capacity);
						return c.json({ ok: true, payload: quote }, { status: 201 });
					} catch (error) {
						return commerceErrorResponse(c, error);
					}
				});
	
	app.get('/v1/commerce/services/requests/:requestId/quotes', async (c) => {
					const request = await store.getCommerceServiceRequest(c.req.param('requestId'));
					if (!request) return jsonError(c, 404, `Unknown commerce service request "${c.req.param('requestId')}".`);
					const access = await requireServiceParticipantAccess(c, store, request, 'projects:read:team');
					if (access.response) return access.response;
					return c.json({ ok: true, payload: await store.listCommerceServiceQuotes(request.id) });
				});
	
	app.post('/v1/commerce/services/quotes/:quoteId/submit', async (c) => {
					const quote = await store.getCommerceServiceQuote(c.req.param('quoteId'));
					if (!quote) return jsonError(c, 404, `Unknown commerce service quote "${c.req.param('quoteId')}".`);
					const request = await store.getCommerceServiceRequest(quote.requestId);
					const access = await requireServiceSellerAccess(c, store, request, 'teams:manage:team');
					if (access.response) return access.response;
					try {
						return c.json({ ok: true, payload: await store.submitCommerceServiceQuote(quote.id, {
							actorType: principalIsSeedAdmin(access.principal) ? 'operator' : 'user',
							actorId: access.principal.id ?? null,
						}, capacity) });
					} catch (error) {
						return commerceErrorResponse(c, error);
					}
				});
	
	app.post('/v1/commerce/services/quotes/:quoteId/buyer-approve', async (c) => {
					const quote = await store.getCommerceServiceQuote(c.req.param('quoteId'));
					if (!quote) return jsonError(c, 404, `Unknown commerce service quote "${c.req.param('quoteId')}".`);
					const request = await store.getCommerceServiceRequest(quote.requestId);
					const access = await requireServiceBuyerAccess(c, store, request);
					if (access.response) return access.response;
					try {
						return c.json({ ok: true, payload: await store.approveCommerceServiceQuoteByBuyer(quote.id, {
							actorType: principalIsSeedAdmin(access.principal) ? 'operator' : 'user',
							actorId: access.principal.id ?? null,
						}, capacity) });
					} catch (error) {
						return commerceErrorResponse(c, error);
					}
				});
	
	app.post('/v1/commerce/services/quotes/:quoteId/vendor-approve', async (c) => {
					const quote = await store.getCommerceServiceQuote(c.req.param('quoteId'));
					if (!quote) return jsonError(c, 404, `Unknown commerce service quote "${c.req.param('quoteId')}".`);
					const request = await store.getCommerceServiceRequest(quote.requestId);
					const access = await requireServiceSellerAccess(c, store, request, 'teams:manage:team');
					if (access.response) return access.response;
					try {
						return c.json({ ok: true, payload: {
							quote: await store.approveCommerceServiceQuoteByVendor(quote.id, {
								actorType: principalIsSeedAdmin(access.principal) ? 'operator' : 'user',
								actorId: access.principal.id ?? null,
							}),
							contract: await store.getCommerceServiceContractForRequest(request.id),
						} });
					} catch (error) {
						return commerceErrorResponse(c, error);
					}
				});
	
	app.post('/v1/commerce/services/quotes/:quoteId/reject', async (c) => {
					const quote = await store.getCommerceServiceQuote(c.req.param('quoteId'));
					if (!quote) return jsonError(c, 404, `Unknown commerce service quote "${c.req.param('quoteId')}".`);
					const request = await store.getCommerceServiceRequest(quote.requestId);
					const access = await requireServiceParticipantAccess(c, store, request, 'teams:manage:team');
					if (access.response) return access.response;
					const body = await c.req.json().catch(() => ({}));
					try {
						return c.json({ ok: true, payload: await store.rejectCommerceServiceQuote(quote.id, {
							reason: optionalTrimmedString(body.reason),
							evidence: body.evidence && typeof body.evidence === 'object' ? body.evidence : {},
							actorType: principalIsSeedAdmin(access.principal) ? 'operator' : 'user',
							actorId: access.principal.id ?? null,
						}) });
					} catch (error) {
						return commerceErrorResponse(c, error);
					}
				});
	
	app.get('/v1/commerce/services/contracts/:contractId', async (c) => {
					const contract = await store.getCommerceServiceContract(c.req.param('contractId'));
					if (!contract) return jsonError(c, 404, `Unknown commerce service contract "${c.req.param('contractId')}".`);
					const request = await store.getCommerceServiceRequest(contract.requestId);
					const access = await requireServiceParticipantAccess(c, store, request, 'projects:read:team');
					if (access.response) return access.response;
					return c.json({ ok: true, payload: contract });
				});
	
	app.post('/v1/commerce/services/contracts/:contractId/checkout', async (c) => {
					const contract = await store.getCommerceServiceContract(c.req.param('contractId'));
					if (!contract) return jsonError(c, 404, `Unknown commerce service contract "${c.req.param('contractId')}".`);
					const request = await store.getCommerceServiceRequest(contract.requestId);
					const access = await requireServiceBuyerAccess(c, store, request);
					if (access.response) return access.response;
					const body = await c.req.json().catch(() => ({}));
					try {
						return c.json({ ok: true, payload: await createCommerceCheckoutRunForServiceContract({
							store,
							stripeConnectService,
							principal: access.principal,
							contractId: contract.id,
							input: body,
						}) });
					} catch (error) {
						return commerceErrorResponse(c, error);
					}
				});
	
	app.post('/v1/commerce/services/contracts/:contractId/link-work', async (c) => {
					const contract = await store.getCommerceServiceContract(c.req.param('contractId'));
					if (!contract) return jsonError(c, 404, `Unknown commerce service contract "${c.req.param('contractId')}".`);
					const request = await store.getCommerceServiceRequest(contract.requestId);
					const access = await requireServiceSellerAccess(c, store, request, 'teams:manage:team');
					if (access.response) return access.response;
					const body = await c.req.json().catch(() => ({}));
					return c.json({ ok: true, payload: await store.linkCommerceServiceContractWork(contract.id, {
						relatedProjectId: optionalTrimmedString(body.relatedProjectId),
						relatedWorkdayId: optionalTrimmedString(body.relatedWorkdayId),
						metadata: body.metadata && typeof body.metadata === 'object' ? body.metadata : contract.metadata,
						actorType: principalIsSeedAdmin(access.principal) ? 'operator' : 'user',
						actorId: access.principal.id ?? null,
					}) });
				});
	
	app.post('/v1/commerce/services/contracts/:contractId/fulfill', async (c) => {
					const contract = await store.getCommerceServiceContract(c.req.param('contractId'));
					if (!contract) return jsonError(c, 404, `Unknown commerce service contract "${c.req.param('contractId')}".`);
					if (contract.status !== 'active') return jsonError(c, 409, 'Only active scoped service contracts can be fulfilled.');
					const request = await store.getCommerceServiceRequest(contract.requestId);
					const access = await requireServiceSellerAccess(c, store, request, 'teams:manage:team');
					if (access.response) return access.response;
					const body = await c.req.json().catch(() => ({}));
					const event = await store.createCommerceFulfillmentEvent({
						orderId: contract.orderId,
						orderItemId: contract.orderItemId,
						entitlementId: contract.entitlementId,
						vendorId: contract.vendorId,
						sellerTeamId: contract.sellerTeamId,
						productId: contract.productId,
						productVersionId: null,
						catalogItemId: null,
						eventType: Array.isArray(body.deliveryRefs) && body.deliveryRefs.length ? 'artifact_delivered' : 'manual_status',
						status: 'delivered',
						artifactRefs: Array.isArray(body.artifactRefs) ? body.artifactRefs : [],
						deliveryRefs: Array.isArray(body.deliveryRefs) ? body.deliveryRefs : [],
						message: optionalTrimmedString(body.summary),
						metadata: { serviceRequestId: contract.requestId, serviceContractId: contract.id, ...(body.metadata && typeof body.metadata === 'object' ? body.metadata : {}) },
						actorType: principalIsSeedAdmin(access.principal) ? 'operator' : 'user',
						actorId: access.principal.id ?? 'system',
					});
					const updated = await store.fulfillCommerceServiceContract(contract.id, {
						summary: optionalTrimmedString(body.summary),
						metadata: body.metadata && typeof body.metadata === 'object' ? body.metadata : contract.metadata,
						actorType: principalIsSeedAdmin(access.principal) ? 'operator' : 'user',
						actorId: access.principal.id ?? null,
					});
					if (contract.orderItemId) await store.updateCommerceOrderItemStatus(contract.orderItemId, { status: 'fulfilled' });
					if (contract.entitlementId) {
						const entitlement = await store.getCommerceEntitlement(contract.entitlementId);
						if (entitlement) {
							await store.updateCommerceEntitlementFulfillment(entitlement.id, {
								fulfillmentArtifactRefs: [
									...(entitlement.fulfillmentArtifactRefs ?? []),
									...(Array.isArray(body.deliveryRefs) ? body.deliveryRefs.map((entry) => entry.path ?? entry.url ?? JSON.stringify(entry)) : []),
								],
								metadata: entitlement.metadata,
							});
						}
					}
					return c.json({ ok: true, payload: { contract: updated, event } });
				});
	
	app.post('/v1/commerce/services/contracts/:contractId/cancel', async (c) => {
					const contract = await store.getCommerceServiceContract(c.req.param('contractId'));
					if (!contract) return jsonError(c, 404, `Unknown commerce service contract "${c.req.param('contractId')}".`);
					const request = await store.getCommerceServiceRequest(contract.requestId);
					const access = await requireServiceParticipantAccess(c, store, request, 'teams:manage:team');
					if (access.response) return access.response;
					const body = await c.req.json().catch(() => ({}));
					return c.json({ ok: true, payload: await store.cancelCommerceServiceContract(contract.id, {
						reason: optionalTrimmedString(body.reason),
						evidence: body.evidence && typeof body.evidence === 'object' ? body.evidence : {},
						actorType: principalIsSeedAdmin(access.principal) ? 'operator' : 'user',
						actorId: access.principal.id ?? null,
					}) });
				});
	
	app.get('/v1/commerce/services/events', async (c) => {
					const auth = await ensurePrincipal(c);
					if (auth.response) return auth.response;
					const requestId = optionalTrimmedString(c.req.query('requestId'));
					if (!requestId && !principalIsSeedAdmin(auth.principal)) return jsonError(c, 400, 'requestId is required.');
					if (requestId) {
						const request = await store.getCommerceServiceRequest(requestId);
						if (!request) return jsonError(c, 404, `Unknown commerce service request "${requestId}".`);
						const access = await requireServiceParticipantAccess(c, store, request, 'projects:read:team');
						if (access.response) return access.response;
						const sellerAccess = principalIsSeedAdmin(access.principal)
							? { response: null }
							: await requireTeamAccess(c, store, request.sellerTeamId, 'projects:read:team');
						const events = await store.listCommerceServiceEvents({ requestId });
						return c.json({ ok: true, payload: sellerAccess.response ? events.map((event) => ({ ...event, evidence: {} })) : events });
					}
					return c.json({ ok: true, payload: await store.listCommerceServiceEvents({
						eventType: optionalTrimmedString(c.req.query('eventType')),
					}) });
				});
	
	app.get('/v1/commerce/orders', async (c) => {
					const auth = await ensurePrincipal(c);
					if (auth.response) return auth.response;
					const filters: Record<string, unknown> = {
						buyerTeamId: optionalTrimmedString(c.req.query('buyerTeamId')),
						vendorId: optionalTrimmedString(c.req.query('vendorId')),
						status: optionalTrimmedString(c.req.query('status')),
						checkoutId: optionalTrimmedString(c.req.query('checkoutId')),
					};
					if (filters.buyerTeamId && !principalIsSeedAdmin(auth.principal)) {
						const access = await requireTeamAccess(c, store, filters.buyerTeamId, 'projects:read:team');
						if (access.response) return access.response;
					}
					if (!filters.buyerTeamId && !filters.vendorId && !principalIsSeedAdmin(auth.principal)) {
						filters.buyerUserId = auth.principal.id;
					}
					return c.json({ ok: true, payload: await store.listCommerceOrders(auth.principal, filters) });
				});
	
	app.get('/v1/commerce/orders/:orderId', async (c) => {
					const auth = await ensurePrincipal(c);
					if (auth.response) return auth.response;
					const order = await store.getCommerceOrder(c.req.param('orderId'));
					if (!order) return jsonError(c, 404, `Unknown commerce order "${c.req.param('orderId')}".`);
					if (order.buyerTeamId && !principalIsSeedAdmin(auth.principal)) {
						const access = await requireTeamAccess(c, store, order.buyerTeamId, 'projects:read:team');
						if (access.response && order.buyerUserId !== auth.principal.id) return access.response;
					} else if (order.buyerUserId && order.buyerUserId !== auth.principal.id && !principalIsSeedAdmin(auth.principal)) {
						return jsonError(c, 403, 'Permission denied.', { orderId: order.id });
					}
					return c.json({ ok: true, payload: { order, items: await store.listCommerceOrderItems(order.id) } });
				});
	
	app.get('/v1/commerce/vendors/:teamId/sales/summary', async (c) => {
					const access = await requireSellerTeamAccess(c, store, c.req.param('teamId'), 'projects:read:team');
					if (access.response) return access.response;
					return c.json({ ok: true, payload: await store.getCommerceVendorSalesSummary(c.req.param('teamId'), {}) });
				});
	
	app.get('/v1/commerce/vendors/:teamId/monitoring', async (c) => {
					const access = await requireSellerTeamAccess(c, store, c.req.param('teamId'), 'projects:read:team');
					if (access.response) return access.response;
					return c.json({ ok: true, payload: await store.getCommerceVendorCommerceMonitor(c.req.param('teamId'), {}) });
				});
	
	app.get('/v1/commerce/vendors/:teamId/sales/orders', async (c) => {
					const access = await requireSellerTeamAccess(c, store, c.req.param('teamId'), 'projects:read:team');
					if (access.response) return access.response;
					return c.json({ ok: true, payload: await store.listCommerceVendorSalesOrders(c.req.param('teamId'), {
						status: optionalTrimmedString(c.req.query('status')),
					}) });
				});
}
