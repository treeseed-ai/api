export function installCommerceVendorOnboardingStripeAndCheckoutRoutes(context: any) {
	const { AGENT_PROMOTION_APPROVAL_DECISIONS, AGENT_TASK_SIGNATURES, AUTH_PROVIDERS, AgentSdk, CHECKOUT_COMMERCIAL_OFFER_MODES, CHECKOUT_OFFER_MODES, CHECKOUT_SUBSCRIPTION_OFFER_MODES, DatabaseAuthProvider, FEEDBACK_SCREENSHOT_TYPES, FEEDBACK_TYPES, GITHUB_ACTIONS_OIDC_ISSUER, HOST_KIND_SESSION_KEYS, LOCAL_CONTENT_COLLECTIONS, LOCAL_CONTENT_DEFAULTS, LOCAL_DECISION_TYPE_VALUES, LOCAL_WORK_CONTENT_COLLECTIONS, MARKET_EMAIL_CONFIRMATION_PREFIX, MAX_FEEDBACK_MESSAGE_LENGTH, MAX_FEEDBACK_SCREENSHOT_BYTES, MarketControlPlaneStore, NOTIFICATION_CONTENT_CAPABILITIES, PERSONAL_THEME_COMPILER_VERSION, PLAINTEXT_HOST_CREDENTIAL_FIELD_NAMES, PLATFORM_OPERATION_SCOPES, POSTGRES_AUTH_PROVIDER_ID, PROPOSAL_VERDICT_DECISION_TYPES, RemoteTreeseedClient, RemoteTreeseedOperationsClient, RemoteTreeseedSdkClient, SENSITIVE_QUERY_PARAM_PATTERN, STRIPE_PRICE_MIRROR_OFFER_MODES, STRIPE_PRODUCT_MIRROR_OFFER_MODES, TreeseedOperationsSdk, accountDeletionBlockers, accountDeletionConfirmationMatches, addRelationValue, apiDatabaseUrl, app, appendLaunchDeploymentEvent, appendLaunchPhaseProjection, appendProjectDeletionProgress, applyCommerceRefundState, applyContentPublishResult, applyHubLaunchFailure, applyHubLaunchResult, applySeedWithStore, artifactDownloadPayload, authConfig, authEmailDeliveryFailureDetail, authEmailDeliveryFailureReason, authProviderId, authTokenTimestampMillis, authTokenTimestampSeconds, availabilityAttempts, availabilityRateLimit, backfillUserEmailAddresses, base64Url, base64urlJson, bearerTokenFromRequest, buildCommerceCheckoutMetadata, buildCommerceStripeMetadata, buildGovernanceApprovalProjection, buildGovernanceProjection, buildInfrastructureProjection, buildKnowledgeArtifactProjection, buildKnowledgeProjection, buildLaunchCredentialOverlay, buildWorkdayProjection, canSkipCloudflareCleanupAfterFailedLaunch, canonicalArchitectureTopology, capacity, centralMarketProfile, checkoutGroupKey, checkoutGroupKind, checkoutGroupStatus, ciOperationForAction, cleanFeedbackString, cloudflareDeletionAuthenticationMessage, cloudflareDnsDomainsForHostValidation, cloudflareErrorMessage, cloudflareProjectDeletionResourceNames, cloudflareRequestForLaunchPreflight, cloudflareRequestForProjectDeletion, collectHostingAuditCredentialOverlay, commerceCheckoutError, commerceErrorResponse, commerceStripeLookupKey, commerceStripePriceParams, commerceStripeProductParams, commerceStripeSyncContext, config, configuredAuthProviderId, confirmationUrlFor, consumeReauthentication, contentRelationPolicy, createApiApp, createApiExtension, createCapacityControlPlane, createCipheriv, createClientEncryptedEscrowService, createCommerceCheckoutRun, createCommerceCheckoutRunForServiceContract, createDecipheriv, createDecisionFromProposals, createGitHubActionsSecretEnclave, createGitHubAppAdapter, createHash, createHmac, createMarketEmailConfirmation, createMarketPostgresDatabase, createMarketWebSession, createOrResendUserEmailAddress, createProjectHostCredentialSessions, createProjectInternalClient, createPublicKey, createRelatedLocalContentRecord, createStripeConnectService, createTreeDxCredentialBridge, createTreeseedApiApp, createVerify, credentialSessionKey, credentialSessionSecret, db, decodeRouteParam, decorateJob, decoratePlatformOperation, decryptCredentialSessionPayload, decryptHostConfig, decryptTeamHostForLaunch, decryptedHostConfigSummary, defaultConfig, deleteCloudflareDnsRecordsForProject, deleteCloudflareProjectResources, deleteTeamCapacityAggregate, derivePlatformOperationNavigation, deriveProjectHostBindingsView, domainInZone, encryptCredentialSessionPayload, encryptedHostPayloadLooksValid, enqueueTreeDxProvisionOperation, ensureCommerceStripeCustomer, ensureMarketCredentialSchema, ensurePrincipal, entitlementRenewalStateFromSubscription, enumValue, exchangeProviderIdentity, executeInline, executeProjectApi, executeSdkOperation, existsSync, exportSeedWithStore, exposeAuthTokenForTests, fallbackRemoteCapability, findById, findDispatchCapability, getSiteAuthConfig, getUserEmailAddress, githubOidcJwksCache, githubRequestForProjectDeletion, grantCommerceEntitlementsForOrder, handleCommerceInvoiceWebhook, handleCommercePaymentIntentWebhook, handleCommerceSubscriptionWebhook, hasRecordedCloudflareRuntimeResources, hashMarketPassword, hostBindingRequiresUnlock, hostKindForBinding, hubRepositoryPolicies, inferZoneNameForDomain, installApiRequestLogger, installCapacityRoutes, installProjectDeploymentRoutes, isLocalAcceptanceServicePrincipal, isLoopbackUrl, isPlatformOperationTerminal, isTeamApiPrincipal, isValidPersonalThemeDraft, jsonError, jsonThrownError, launchCapabilityPreset, launchPlannerRepositoryTopology, listCloudflareNamedResources, listTreeseedManagedHostsFromConfig, listUserEmailAddresses, loadGitHubOidcJwks, loadInfrastructureSeedState, loadKnowledgeContentEntries, loadNotificationPreferences, loadProjectHostBindingContext, loadTemplateCatalog, localAcceptanceAdminToken, localAcceptanceAuthEnabled, localContentPath, localContentRoot, logRequests, managedCloudflareConfigMissing, markdownToPlainProjectSummary, marketAuthContext, marketEmailTokenHash, marketProfilesForTeams, mergeCapability, mergeStringConfig, mkdir, nonSecretLaunchJobInput, normalizeAppearancePreference, normalizeAuditHostKinds, normalizeBaseUrl, normalizeCheckoutQuantity, normalizeCiEnvironment, normalizeDomainName, normalizeEmail, normalizeLocalContentInput, normalizeMarketProfile, normalizeNotificationPreferences, normalizeProjectDomainInput, normalizeProjectLaunchHostBindings, normalizeProviderCredentialConfig, normalizeRelationArray, normalizeRepositoryContentInput, normalizeRepositoryRelationArray, normalizeRepositorySlug, normalizeSeedEnvironments, normalizeTemplateLaunchRequirements, normalizeTreeseedTemplateId, normalizeUsername, normalizedCloudflareKvNamespaceReference, operationTokenSecret, optionalTrimmedString, orderStatusFromPaymentGroup, parseBase64urlJson, parseBooleanEnvValue, parseJsonObject, parseYaml, passwordResetUrlFor, patchLaunchIntentForCredentialOverlay, paymentGroupStatusFromPaymentIntent, pbkdf2Sync, persistProjectHostBindingOperationMetadata, personalThemeFromRow, plaintextHostCredentialFieldPaths, planKnowledgeHubLaunch, planProjectHostBindingOperation, planSeedWithStore, platformOperationMutationError, principalCanManageCommerceProduct, principalHasGlobalPlatformRole, principalHasPermission, principalIsSeedAdmin, privateKnowledgeAuditPayload, processCommerceStripeWebhook, projectAllowedCiRepositories, projectApiConnection, projectAppHref, projectDeletionBlockerRows, projectDeletionConfirmationMatches, projectDeletionHostname, projectDeletionOperation, projectHostBindingMetadata, projectHostResponsePayload, providerConfigFor, providerCredentialValuesForAudit, providerJwksCache, publicPaymentGroups, randomBytes, randomUUID, readCapacityRequestObject, readFile, readJsonOrFormBody, readLocalContentRecord, recordContentNotificationEvent, recordFeedbackSubmission, recordPrivateKnowledgeAudit, redactCommerceOwnershipWorkflow, redactCommerceServiceRequestForBuyer, redactedRequestTarget, refreshCommercePaymentGroupState, refreshCommerceStripeAccount, rejectPlaintextHostCredentialFields, rejectProjectSecretUnlockMaterial, relative, remainingRefundableAmount, repositoryContentRelationPolicy, repositoryInventoryWithPlatform, requestClientIp, requestSessionMetadata, requireCatalogItemAccess, requireCommerceCapacityInquiryAccess, requireCommerceCapacityListingAccess, requireCommerceOfferAccess, requireCommerceProductAccess, requireCommerceVendorForStripe, requireConfiguredServiceCredential, requireConnectedProjectRuntime, requirePlatformRunner, requireProjectAccess, requireProjectRunner, requireSeedApplyAccess, requireSeedPlanAccess, requireSellerTeamAccess, requireServiceBuyerAccess, requireServiceParticipantAccess, requireServiceSellerAccess, requireTeamAccess, requireVendorOrderManager, resolve, resolveAgentArtifactBucket, resolveAgentTaskSignature, resolveApiConfig, resolveAuthApprovalBaseUrl, resolveCloudflareZoneForLaunchPreflight, resolveCommerceCheckoutItem, resolveFulfillmentArtifact, resolveLaunchTemplateRequirements, resolveOrderItemForRefund, resolvePlatformRepositoryDescriptor, resolvePlatformRunnerSecret, resolveProjectDeletionCloudflareZone, resolveProjectLaunchHostBindings, resolvePublicTreeDxTeam, resolveStripeEnvironment, resolveStripePublishableKey, resolveStripeWebhookSecret, resolveTreeseedManagedCloudflareHostConfigFromConfig, resolveUiProjectionContext, resourceRowsFromLaunch, retryApiLaunchBootstrapFromRequest, rm, runProjectDeletionApiDestroy, runProjectLaunchApiBootstrap, runTreeseedHostingAudit, runtime, runtimeMarketAuthProvider, runtimeProviders, safeFeedbackClient, safeFeedbackContext, safeFeedbackScreenshot, safePlatformOperationOutput, safePrivateKnowledgeSlug, safeTokenEquals, sanitizeLaunchResultForStorage, sanitizedReturnTo, scheduleBackgroundBootstrap, seedActor, seedCreatesMissingTeams, seedExistingTeamIds, selectDispatchTarget, sendAuthEmail, sendEmailConfirmation, sendTeamInviteEmail, sendWelcomeEmail, serializeFrontmatter, serializeUserEmailAddress, setPrimaryEmailAddress, sharedSdk, shouldBypassAcceptanceAuthEmailDelivery, shouldExposeNonProductionAuthDiagnostics, shouldLogApiRequests, signEditorialPreviewToken, signOperationToken, slugifyContent, slugifyRepositoryContent, sourceFromProjectDetails, store, stripeAccountMissingError, stripeAccountToConnectedAccountPatch, stripeClientSecret, stripeCommerceUrl, stripeConfiguredError, stripeConnectService, stripeMetadataValue, stripePriceTermsDrift, stripeRefundStatus, stripeTimestampToIso, stripeVendorApprovalError, subscriptionClientSecret, subscriptionStatusFromStripe, syncCommerceOfferStripeProduct, syncCommercePriceStripePrice, syncCommerceSubscriptionFromStripe, syncPrimaryEmailCaches, teamInviteAcceptUrlFor, timingSafeEqual, trimmedHeaderValue, uiRuntimeLocals, uniqueCloudflareKvNamespaceReferences, uniqueRelationArray, unknownKeys, unwrapLaunchOperationOutput, unwrapOperationPayload, updateCheckoutCompletionFromGroup, updateLaunchDeployments, validateCiRefForEnvironment, validateFeedbackAccess, validateMarketPassword, validateProjectSlug, validatePublicUsername, validateTeamHostCredentialPayload, verifiedEmailCount, verifyCloudflareDnsWriteForLaunch, verifyGitHubOidcToken, verifyMarketPassword, verifyOperationToken, verifyProviderIdToken, webAuthPayload, webSessionData, writeFile, writeLocalContentRecord, writeParsedLocalContentRecord, yamlLines, yamlScalar } = context;
	app.get('/v1/commerce/vendors/:teamId', async (c) => {
					const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'projects:read:team');
					if (access.response) return access.response;
					return c.json({ ok: true, payload: await store.getCommerceVendorForTeam(c.req.param('teamId')) });
				});
	
	app.post('/v1/commerce/vendors/:teamId/request', async (c) => {
					const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'teams:manage:team');
					if (access.response) return access.response;
					const body = await c.req.json().catch(() => ({}));
					try {
						return c.json({
							ok: true,
							payload: await store.requestCommerceVendor(c.req.param('teamId'), {
								id: optionalTrimmedString(body.id),
								displayName: optionalTrimmedString(body.displayName),
								slug: optionalTrimmedString(body.slug),
								professionalEntitlementId: optionalTrimmedString(body.professionalEntitlementId),
								metadata: body.metadata && typeof body.metadata === 'object' ? body.metadata : {},
								reason: optionalTrimmedString(body.reason),
								evidence: body.evidence && typeof body.evidence === 'object' ? body.evidence : {},
								actorType: 'user',
								actorId: access.principal.id ?? null,
							}),
						});
					} catch (error) {
						return commerceErrorResponse(c, error);
					}
				});
	
	app.post('/v1/commerce/vendors/:vendorId/approve', async (c) => {
					const auth = await ensurePrincipal(c);
					if (auth.response) return auth.response;
					if (!principalIsSeedAdmin(auth.principal)) {
						return jsonError(c, 403, 'Permission denied.', { permission: 'commerce:approve:global' });
					}
					const body = await c.req.json().catch(() => ({}));
					try {
						const vendor = await store.approveCommerceVendor(c.req.param('vendorId'), {
							trustLevel: optionalTrimmedString(body.trustLevel),
							salesEnabled: body.salesEnabled !== false,
							serviceSalesEnabled: body.serviceSalesEnabled === true,
							capacityListingsEnabled: body.capacityListingsEnabled === true,
							reason: optionalTrimmedString(body.reason),
							evidence: body.evidence && typeof body.evidence === 'object' ? body.evidence : {},
							actorType: 'operator',
							actorId: auth.principal.id ?? null,
						});
						if (!vendor) return jsonError(c, 404, `Unknown commerce vendor "${c.req.param('vendorId')}".`);
						return c.json({ ok: true, payload: vendor });
					} catch (error) {
						return commerceErrorResponse(c, error);
					}
				});
	
	app.post('/v1/commerce/vendors/:teamId/stripe/onboarding', async (c) => {
					const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'teams:manage:team');
					if (access.response) return access.response;
					const body = await c.req.json().catch(() => ({}));
					try {
						if (!await stripeConnectService.isConfigured()) throw stripeConfiguredError();
						const vendor = await requireCommerceVendorForStripe(store, c.req.param('teamId'));
						const environment = stripeConnectService.environment ?? resolveStripeEnvironment(runtime.resolved.config);
						let account = await store.getCommerceVendorStripeAccount(vendor.id, environment);
						if (!account) {
							const team = await store.getTeam(vendor.teamId).catch(() => null);
							const stripeAccount = await stripeConnectService.createExpressAccount({ vendor, team });
							if (!stripeAccount?.id) throw stripeConfiguredError();
							account = await store.createCommerceVendorStripeAccount(vendor.id, {
								...stripeAccountToConnectedAccountPatch(stripeAccount, environment),
								actorType: 'user',
								actorId: access.principal.id ?? null,
								evidence: { environment, provider: 'stripe_connect_express' },
							});
						}
						const returnUrl = optionalTrimmedString(body.returnUrl)
							?? stripeCommerceUrl(runtime.resolved.config, vendor.teamId, 'returned');
						const refreshUrl = optionalTrimmedString(body.refreshUrl)
							?? stripeCommerceUrl(runtime.resolved.config, vendor.teamId, 'refresh');
						const link = await stripeConnectService.createOnboardingLink({
							stripeAccountId: account.stripeAccountId,
							returnUrl,
							refreshUrl,
						});
						if (!link?.url) throw stripeConfiguredError();
						account = await store.markCommerceStripeOnboardingStarted(account.id, {
							actorType: 'user',
							actorId: access.principal.id ?? null,
							evidence: { environment },
						});
						return c.json({ ok: true, payload: { account, onboardingUrl: link.url } });
					} catch (error) {
						return commerceErrorResponse(c, error);
					}
				});
	
	app.get('/v1/commerce/vendors/:teamId/stripe/status', async (c) => {
					const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'projects:read:team');
					if (access.response) return access.response;
					try {
						const vendor = await store.getCommerceVendorForTeam(c.req.param('teamId'));
						if (!vendor) return c.json({ ok: true, payload: null });
						const environment = stripeConnectService.environment ?? resolveStripeEnvironment(runtime.resolved.config);
						let account = await store.getCommerceVendorStripeAccount(vendor.id, environment);
						if (account && c.req.query('refresh') === '1') {
							account = await refreshCommerceStripeAccount({
								store,
								stripeConnectService,
								account,
								actorType: 'user',
								actorId: access.principal.id ?? null,
							});
						}
						return c.json({ ok: true, payload: account });
					} catch (error) {
						return commerceErrorResponse(c, error);
					}
				});
	
	app.post('/v1/commerce/vendors/:teamId/stripe/return', async (c) => {
					const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'teams:manage:team');
					if (access.response) return access.response;
					try {
						const vendor = await requireCommerceVendorForStripe(store, c.req.param('teamId'));
						const environment = stripeConnectService.environment ?? resolveStripeEnvironment(runtime.resolved.config);
						let account = await store.getCommerceVendorStripeAccount(vendor.id, environment);
						if (!account) throw stripeAccountMissingError();
						account = await store.markCommerceStripeOnboardingReturned(account.id, {
							actorType: 'user',
							actorId: access.principal.id ?? null,
							evidence: { environment },
						});
						account = await refreshCommerceStripeAccount({
							store,
							stripeConnectService,
							account,
							actorType: 'user',
							actorId: access.principal.id ?? null,
						});
						return c.json({ ok: true, payload: account });
					} catch (error) {
						return commerceErrorResponse(c, error);
					}
				});
	
	app.post('/v1/commerce/vendors/:teamId/stripe/login-link', async (c) => {
					const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'teams:manage:team');
					if (access.response) return access.response;
					try {
						if (!await stripeConnectService.isConfigured()) throw stripeConfiguredError();
						const vendor = await requireCommerceVendorForStripe(store, c.req.param('teamId'));
						const environment = stripeConnectService.environment ?? resolveStripeEnvironment(runtime.resolved.config);
						const account = await store.getCommerceVendorStripeAccount(vendor.id, environment);
						if (!account) throw stripeAccountMissingError();
						const link = await stripeConnectService.createLoginLink(account.stripeAccountId);
						if (!link?.url) throw stripeConfiguredError();
						await store.recordCommerceGovernanceEvent({
							actorType: 'user',
							actorId: access.principal.id ?? null,
							action: 'commerce_vendor.stripe_login_link.created',
							objectType: 'commerce_vendor',
							objectId: vendor.id,
							priorState: account.accountStatus,
							nextState: account.accountStatus,
							evidence: { environment },
							relatedTeamId: vendor.teamId,
						});
						return c.json({ ok: true, payload: { account, loginUrl: link.url } });
					} catch (error) {
						return commerceErrorResponse(c, error);
					}
				});
	
	app.get('/v1/commerce/stripe/config', async (c) => {
					const publishableKey = resolveStripePublishableKey(runtime.resolved.config);
					try {
						if (!publishableKey || !await stripeConnectService.isConfigured()) {
							return jsonError(c, 409, 'Stripe checkout is not configured for this market.');
						}
						return c.json({
							ok: true,
							payload: {
								publishableKey,
								environment: stripeConnectService.environment ?? resolveStripeEnvironment(runtime.resolved.config),
							},
						});
					} catch (error) {
						return commerceErrorResponse(c, error);
					}
				});
	
	app.post('/v1/commerce/cart', async (c) => {
					const auth = await ensurePrincipal(c);
					if (auth.response) return auth.response;
					const body = await c.req.json().catch(() => ({}));
					const buyerTeamId = optionalTrimmedString(body.buyerTeamId);
					if (buyerTeamId) {
						const access = await requireTeamAccess(c, store, buyerTeamId, 'projects:read:team');
						if (access.response) return access.response;
					}
					try {
						return c.json({ ok: true, payload: await store.createCommerceCart(auth.principal, {
							buyerTeamId,
							buyerUserId: auth.principal.id ?? null,
							currency: optionalTrimmedString(body.currency),
							metadata: body.metadata && typeof body.metadata === 'object' ? body.metadata : {},
						}) });
					} catch (error) {
						return commerceErrorResponse(c, error);
					}
				});
	
	app.get('/v1/commerce/cart/:cartId', async (c) => {
					const auth = await ensurePrincipal(c);
					if (auth.response) return auth.response;
					const cart = await store.getCommerceCart(c.req.param('cartId'));
					if (!cart) return jsonError(c, 404, `Unknown commerce cart "${c.req.param('cartId')}".`);
					if (cart.buyerTeamId) {
						const access = await requireTeamAccess(c, store, cart.buyerTeamId, 'projects:read:team');
						if (access.response && !principalIsSeedAdmin(auth.principal)) return access.response;
					} else if (cart.buyerUserId && cart.buyerUserId !== auth.principal.id && !principalIsSeedAdmin(auth.principal)) {
						return jsonError(c, 403, 'Permission denied.', { cartId: cart.id });
					}
					return c.json({ ok: true, payload: { cart, items: await store.listCommerceCartItems(cart.id) } });
				});
	
	app.post('/v1/commerce/cart/:cartId/items', async (c) => {
					const auth = await ensurePrincipal(c);
					if (auth.response) return auth.response;
					const cart = await store.getCommerceCart(c.req.param('cartId'));
					if (!cart) return jsonError(c, 404, `Unknown commerce cart "${c.req.param('cartId')}".`);
					if (cart.buyerTeamId) {
						const access = await requireTeamAccess(c, store, cart.buyerTeamId, 'projects:read:team');
						if (access.response && !principalIsSeedAdmin(auth.principal)) return access.response;
					} else if (cart.buyerUserId && cart.buyerUserId !== auth.principal.id && !principalIsSeedAdmin(auth.principal)) {
						return jsonError(c, 403, 'Permission denied.', { cartId: cart.id });
					}
					const body = await c.req.json().catch(() => ({}));
					try {
						return c.json({ ok: true, payload: await store.addCommerceCartItem(cart.id, {
							offerId: optionalTrimmedString(body.offerId),
							priceId: optionalTrimmedString(body.priceId),
							quantity: normalizeCheckoutQuantity(body.quantity),
							metadata: body.metadata && typeof body.metadata === 'object' ? body.metadata : {},
							actorType: 'user',
							actorId: auth.principal.id ?? null,
						}) });
					} catch (error) {
						return commerceErrorResponse(c, error);
					}
				});
	
	app.delete('/v1/commerce/cart/:cartId/items/:itemId', async (c) => {
					const auth = await ensurePrincipal(c);
					if (auth.response) return auth.response;
					const cart = await store.getCommerceCart(c.req.param('cartId'));
					if (!cart) return jsonError(c, 404, `Unknown commerce cart "${c.req.param('cartId')}".`);
					if (cart.buyerUserId && cart.buyerUserId !== auth.principal.id && !principalIsSeedAdmin(auth.principal)) {
						return jsonError(c, 403, 'Permission denied.', { cartId: cart.id });
					}
					return c.json({ ok: true, payload: await store.removeCommerceCartItem(c.req.param('itemId')) });
				});
	
	app.post('/v1/commerce/checkout', async (c) => {
					const auth = await ensurePrincipal(c);
					if (auth.response) return auth.response;
					const body = await c.req.json().catch(() => ({}));
					if (body.buyerTeamId) {
						const access = await requireTeamAccess(c, store, body.buyerTeamId, 'projects:read:team');
						if (access.response) return access.response;
					}
					try {
						const payload = await createCommerceCheckoutRun({
							store,
							stripeConnectService,
							principal: auth.principal,
							input: body,
						});
						return c.json({ ok: true, payload });
					} catch (error) {
						return commerceErrorResponse(c, error);
					}
				});
	
	app.get('/v1/commerce/checkouts/:checkoutId', async (c) => {
					const auth = await ensurePrincipal(c);
					if (auth.response) return auth.response;
					const checkout = await store.getCommerceCheckout(c.req.param('checkoutId'));
					if (!checkout) return jsonError(c, 404, `Unknown commerce checkout "${c.req.param('checkoutId')}".`);
					if (checkout.buyerTeamId) {
						const access = await requireTeamAccess(c, store, checkout.buyerTeamId, 'projects:read:team');
						if (access.response && !principalIsSeedAdmin(auth.principal)) return access.response;
					} else if (checkout.buyerUserId && checkout.buyerUserId !== auth.principal.id && !principalIsSeedAdmin(auth.principal)) {
						return jsonError(c, 403, 'Permission denied.', { checkoutId: checkout.id });
					}
					const orders = await store.listCommerceCheckoutOrders(checkout.id);
					const paymentGroups = [];
					const entitlements = [];
					for (const order of orders) {
						const groups = await store.all?.(`SELECT * FROM commerce_payment_groups WHERE order_id = ?`, [order.id]).catch(() => []);
						paymentGroups.push(...groups.map((row) => {
							const group = {
								id: row.id,
								checkoutId: row.checkout_id,
								orderId: row.order_id,
								vendorId: row.vendor_id,
								sellerTeamId: row.seller_team_id,
								connectedAccountId: row.connected_account_id,
								groupKind: row.group_kind,
								billingInterval: row.billing_interval,
								status: row.status,
								currency: row.currency,
								subtotalAmount: Number(row.subtotal_amount ?? 0),
								totalAmount: Number(row.total_amount ?? 0),
								stripePaymentIntentId: row.stripe_payment_intent_id,
								stripeSubscriptionId: row.stripe_subscription_id,
								stripeCustomerId: row.stripe_customer_id,
								clientSecret: null,
								metadata: row.metadata_json ? JSON.parse(row.metadata_json) : {},
								createdAt: row.created_at,
								updatedAt: row.updated_at,
							};
							return group;
						}));
						entitlements.push(...await store.listCommerceEntitlements(auth.principal, { orderId: order.id }));
					}
					return c.json({ ok: true, payload: { checkout, orders, paymentGroups, entitlements } });
				});
	
	app.post('/v1/commerce/payment-groups/:groupId/refresh', async (c) => {
					const auth = await ensurePrincipal(c);
					if (auth.response) return auth.response;
					try {
						const group = await store.getCommercePaymentGroup(c.req.param('groupId'));
						if (!group) return jsonError(c, 404, `Unknown commerce payment group "${c.req.param('groupId')}".`);
						const order = await store.getCommerceOrder(group.orderId);
						if (!order) return jsonError(c, 404, `Unknown commerce order "${group.orderId}".`);
						if (order.buyerTeamId) {
							const access = await requireTeamAccess(c, store, order.buyerTeamId, 'projects:read:team');
							if (access.response && !principalIsSeedAdmin(auth.principal)) return access.response;
						} else if (order.buyerUserId && order.buyerUserId !== auth.principal.id && !principalIsSeedAdmin(auth.principal)) {
							return jsonError(c, 403, 'Permission denied.', { orderId: order.id });
						}
						const payload = await refreshCommercePaymentGroupState({ store, stripeConnectService, group });
						await updateCheckoutCompletionFromGroup(store, payload.group);
						const publicGroup = publicPaymentGroups([payload.group])[0];
						return c.json({
							ok: true,
							payload: {
								...payload,
								group: publicGroup,
								paymentGroup: publicGroup,
								clientSecret: payload.clientSecret ?? null,
							},
						});
					} catch (error) {
						return commerceErrorResponse(c, error);
					}
				});
	
	app.post('/v1/commerce/services/requests', async (c) => {
					const auth = await ensurePrincipal(c);
					if (auth.response) return auth.response;
					const body = await c.req.json().catch(() => ({}));
					const buyerTeamId = optionalTrimmedString(body.buyerTeamId);
					if (buyerTeamId) {
						const access = await requireTeamAccess(c, store, buyerTeamId, 'projects:read:team');
						if (access.response) return access.response;
					}
					try {
						const request = await store.createCommerceServiceRequest(auth.principal, {
							buyerTeamId,
							offerId: optionalTrimmedString(body.offerId),
							requestedScope: optionalTrimmedString(body.requestedScope),
							accessNeeds: body.accessNeeds && typeof body.accessNeeds === 'object' ? body.accessNeeds : {},
							relatedProjectId: optionalTrimmedString(body.relatedProjectId),
							relatedWorkdayId: optionalTrimmedString(body.relatedWorkdayId),
							metadata: body.metadata && typeof body.metadata === 'object' ? body.metadata : {},
							actorType: 'user',
							actorId: auth.principal.id ?? null,
						});
						return c.json({ ok: true, payload: request }, { status: 201 });
					} catch (error) {
						return commerceErrorResponse(c, error);
					}
				});
}
