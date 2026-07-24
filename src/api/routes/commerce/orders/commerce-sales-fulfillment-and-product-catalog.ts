export function installCommerceSalesFulfillmentAndProductCatalogRoutes(context: any) {
	const { AGENT_PROMOTION_APPROVAL_DECISIONS, AGENT_TASK_SIGNATURES, AUTH_PROVIDERS, AgentSdk, CHECKOUT_COMMERCIAL_OFFER_MODES, CHECKOUT_OFFER_MODES, CHECKOUT_SUBSCRIPTION_OFFER_MODES, DatabaseAuthProvider, FEEDBACK_SCREENSHOT_TYPES, FEEDBACK_TYPES, GITHUB_ACTIONS_OIDC_ISSUER, HOST_KIND_SESSION_KEYS, LOCAL_CONTENT_COLLECTIONS, LOCAL_CONTENT_DEFAULTS, LOCAL_DECISION_TYPE_VALUES, LOCAL_WORK_CONTENT_COLLECTIONS, MARKET_EMAIL_CONFIRMATION_PREFIX, MAX_FEEDBACK_MESSAGE_LENGTH, MAX_FEEDBACK_SCREENSHOT_BYTES, MarketControlPlaneStore, NOTIFICATION_CONTENT_CAPABILITIES, PERSONAL_THEME_COMPILER_VERSION, PLAINTEXT_HOST_CREDENTIAL_FIELD_NAMES, PLATFORM_OPERATION_SCOPES, POSTGRES_AUTH_PROVIDER_ID, PROPOSAL_VERDICT_DECISION_TYPES, RemoteClient, RemoteOperationsClient, RemoteSdkClient, SENSITIVE_QUERY_PARAM_PATTERN, STRIPE_PRICE_MIRROR_OFFER_MODES, STRIPE_PRODUCT_MIRROR_OFFER_MODES, OperationsSdk, accountDeletionBlockers, accountDeletionConfirmationMatches, addRelationValue, apiDatabaseUrl, app, appendLaunchDeploymentEvent, appendLaunchPhaseProjection, appendProjectDeletionProgress, applyCommerceRefundState, applyContentPublishResult, applyHubLaunchFailure, applyHubLaunchResult, applySeedWithStore, artifactDownloadPayload, authConfig, authEmailDeliveryFailureDetail, authEmailDeliveryFailureReason, authProviderId, authTokenTimestampMillis, authTokenTimestampSeconds, availabilityAttempts, availabilityRateLimit, backfillUserEmailAddresses, base64Url, base64urlJson, bearerTokenFromRequest, buildCommerceCheckoutMetadata, buildCommerceStripeMetadata, buildGovernanceApprovalProjection, buildGovernanceProjection, buildInfrastructureProjection, buildKnowledgeArtifactProjection, buildKnowledgeProjection, buildLaunchCredentialOverlay, buildWorkdayProjection, canSkipCloudflareCleanupAfterFailedLaunch, canonicalArchitectureTopology, capacity, centralMarketProfile, checkoutGroupKey, checkoutGroupKind, checkoutGroupStatus, ciOperationForAction, cleanFeedbackString, cloudflareDeletionAuthenticationMessage, cloudflareDnsDomainsForHostValidation, cloudflareErrorMessage, cloudflareProjectDeletionResourceNames, cloudflareRequestForLaunchPreflight, cloudflareRequestForProjectDeletion, collectHostingAuditCredentialOverlay, commerceCheckoutError, commerceErrorResponse, commerceStripeLookupKey, commerceStripePriceParams, commerceStripeProductParams, commerceStripeSyncContext, config, configuredAuthProviderId, confirmationUrlFor, consumeReauthentication, contentRelationPolicy, createApiExtension, createCapacityControlPlane, createCipheriv, createClientEncryptedEscrowService, createCommerceCheckoutRun, createCommerceCheckoutRunForServiceContract, createDecipheriv, createDecisionFromProposals, createGitHubActionsSecretEnclave, createGitHubAppAdapter, createHash, createHmac, createMarketEmailConfirmation, createMarketPostgresDatabase, createMarketWebSession, createOrResendUserEmailAddress, createProjectHostCredentialSessions, createProjectInternalClient, createPublicKey, createRelatedLocalContentRecord, createStripeConnectService, createTreeDxCredentialBridge, createVerify, credentialSessionKey, credentialSessionSecret, db, decodeRouteParam, decorateJob, decoratePlatformOperation, decryptCredentialSessionPayload, decryptHostConfig, decryptTeamHostForLaunch, decryptedHostConfigSummary, defaultConfig, deleteCloudflareDnsRecordsForProject, deleteCloudflareProjectResources, deleteTeamCapacityAggregate, derivePlatformOperationNavigation, deriveProjectHostBindingsView, domainInZone, encryptCredentialSessionPayload, encryptedHostPayloadLooksValid, enqueueTreeDxProvisionOperation, ensureCommerceStripeCustomer, ensureMarketCredentialSchema, ensurePrincipal, entitlementRenewalStateFromSubscription, enumValue, exchangeProviderIdentity, executeInline, executeProjectApi, executeSdkOperation, existsSync, exportSeedWithStore, exposeAuthTokenForTests, fallbackRemoteCapability, findById, findDispatchCapability, getSiteAuthConfig, getUserEmailAddress, githubOidcJwksCache, githubRequestForProjectDeletion, grantCommerceEntitlementsForOrder, handleCommerceInvoiceWebhook, handleCommercePaymentIntentWebhook, handleCommerceSubscriptionWebhook, hasRecordedCloudflareRuntimeResources, hashMarketPassword, hostBindingRequiresUnlock, hostKindForBinding, hubRepositoryPolicies, inferZoneNameForDomain, installApiRequestLogger, installCapacityRoutes, installProjectDeploymentRoutes, isLocalAcceptanceServicePrincipal, isLoopbackUrl, isPlatformOperationTerminal, isTeamApiPrincipal, isValidPersonalThemeDraft, jsonError, jsonThrownError, launchCapabilityPreset, launchPlannerRepositoryTopology, listCloudflareNamedResources, listManagedHostsFromConfig, listUserEmailAddresses, loadGitHubOidcJwks, loadInfrastructureSeedState, loadKnowledgeContentEntries, loadNotificationPreferences, loadProjectHostBindingContext, loadTemplateCatalog, localAcceptanceAdminToken, localAcceptanceAuthEnabled, localContentPath, localContentRoot, logRequests, managedCloudflareConfigMissing, markdownToPlainProjectSummary, marketAuthContext, marketEmailTokenHash, marketProfilesForTeams, mergeCapability, mergeStringConfig, mkdir, nonSecretLaunchJobInput, normalizeAppearancePreference, normalizeAuditHostKinds, normalizeBaseUrl, normalizeCheckoutQuantity, normalizeCiEnvironment, normalizeDomainName, normalizeEmail, normalizeLocalContentInput, normalizeMarketProfile, normalizeNotificationPreferences, normalizeProjectDomainInput, normalizeProjectLaunchHostBindings, normalizeProviderCredentialConfig, normalizeRelationArray, normalizeRepositoryContentInput, normalizeRepositoryRelationArray, normalizeRepositorySlug, normalizeSeedEnvironments, normalizeTemplateLaunchRequirements, normalizeTemplateId, normalizeUsername, normalizedCloudflareKvNamespaceReference, operationTokenSecret, optionalTrimmedString, orderStatusFromPaymentGroup, parseBase64urlJson, parseBooleanEnvValue, parseJsonObject, parseYaml, passwordResetUrlFor, patchLaunchIntentForCredentialOverlay, paymentGroupStatusFromPaymentIntent, pbkdf2Sync, persistProjectHostBindingOperationMetadata, personalThemeFromRow, plaintextHostCredentialFieldPaths, planKnowledgeHubLaunch, planProjectHostBindingOperation, planSeedWithStore, platformOperationMutationError, principalCanManageCommerceProduct, principalHasGlobalPlatformRole, principalHasPermission, principalIsSeedAdmin, privateKnowledgeAuditPayload, processCommerceStripeWebhook, projectAllowedCiRepositories, projectApiConnection, projectAppHref, projectDeletionBlockerRows, projectDeletionConfirmationMatches, projectDeletionHostname, projectDeletionOperation, projectHostBindingMetadata, projectHostResponsePayload, providerConfigFor, providerCredentialValuesForAudit, providerJwksCache, publicPaymentGroups, randomBytes, randomUUID, readCapacityRequestObject, readFile, readJsonOrFormBody, readLocalContentRecord, recordContentNotificationEvent, recordFeedbackSubmission, recordPrivateKnowledgeAudit, redactCommerceOwnershipWorkflow, redactCommerceServiceRequestForBuyer, redactedRequestTarget, refreshCommercePaymentGroupState, refreshCommerceStripeAccount, rejectPlaintextHostCredentialFields, rejectProjectSecretUnlockMaterial, relative, remainingRefundableAmount, repositoryContentRelationPolicy, repositoryInventoryWithPlatform, requestClientIp, requestSessionMetadata, requireCatalogItemAccess, requireCommerceCapacityInquiryAccess, requireCommerceCapacityListingAccess, requireCommerceOfferAccess, requireCommerceProductAccess, requireCommerceVendorForStripe, requireConfiguredServiceCredential, requireConnectedProjectRuntime, requirePlatformRunner, requireProjectAccess, requireProjectRunner, requireSeedApplyAccess, requireSeedPlanAccess, requireSellerTeamAccess, requireServiceBuyerAccess, requireServiceParticipantAccess, requireServiceSellerAccess, requireTeamAccess, requireVendorOrderManager, resolve, resolveAgentArtifactBucket, resolveAgentTaskSignature, resolveApiConfig, resolveAuthApprovalBaseUrl, resolveCloudflareZoneForLaunchPreflight, resolveCommerceCheckoutItem, resolveFulfillmentArtifact, resolveLaunchTemplateRequirements, resolveOrderItemForRefund, resolvePlatformRepositoryDescriptor, resolvePlatformRunnerSecret, resolveProjectDeletionCloudflareZone, resolveProjectLaunchHostBindings, resolvePublicTreeDxTeam, resolveStripeEnvironment, resolveStripePublishableKey, resolveStripeWebhookSecret, resolveManagedCloudflareHostConfigFromConfig, resolveUiProjectionContext, resourceRowsFromLaunch, retryApiLaunchBootstrapFromRequest, rm, runProjectDeletionApiDestroy, runProjectLaunchApiBootstrap, runHostingAudit, runtime, runtimeMarketAuthProvider, runtimeProviders, safeFeedbackClient, safeFeedbackContext, safeFeedbackScreenshot, safePlatformOperationOutput, safePrivateKnowledgeSlug, safeTokenEquals, sanitizeLaunchResultForStorage, sanitizedReturnTo, scheduleBackgroundBootstrap, seedActor, seedCreatesMissingTeams, seedExistingTeamIds, selectDispatchTarget, sendAuthEmail, sendEmailConfirmation, sendTeamInviteEmail, sendWelcomeEmail, serializeFrontmatter, serializeUserEmailAddress, setPrimaryEmailAddress, sharedSdk, shouldBypassAcceptanceAuthEmailDelivery, shouldExposeNonProductionAuthDiagnostics, shouldLogApiRequests, signEditorialPreviewToken, signOperationToken, slugifyContent, slugifyRepositoryContent, sourceFromProjectDetails, store, stripeAccountMissingError, stripeAccountToConnectedAccountPatch, stripeClientSecret, stripeCommerceUrl, stripeConfiguredError, stripeConnectService, stripeMetadataValue, stripePriceTermsDrift, stripeRefundStatus, stripeTimestampToIso, stripeVendorApprovalError, subscriptionClientSecret, subscriptionStatusFromStripe, syncCommerceOfferStripeProduct, syncCommercePriceStripePrice, syncCommerceSubscriptionFromStripe, syncPrimaryEmailCaches, teamInviteAcceptUrlFor, timingSafeEqual, trimmedHeaderValue, uiRuntimeLocals, uniqueCloudflareKvNamespaceReferences, uniqueRelationArray, unknownKeys, unwrapLaunchOperationOutput, unwrapOperationPayload, updateCheckoutCompletionFromGroup, updateLaunchDeployments, validateCiRefForEnvironment, validateFeedbackAccess, validateMarketPassword, validateProjectSlug, validatePublicUsername, validateTeamHostCredentialPayload, verifiedEmailCount, verifyCloudflareDnsWriteForLaunch, verifyGitHubOidcToken, verifyMarketPassword, verifyOperationToken, verifyProviderIdToken, webAuthPayload, webSessionData, writeFile, writeLocalContentRecord, writeParsedLocalContentRecord, yamlLines, yamlScalar } = context;
	app.get('/v1/commerce/vendors/:teamId/sales/subscriptions', async (c) => {
					const access = await requireSellerTeamAccess(c, store, c.req.param('teamId'), 'projects:read:team');
					if (access.response) return access.response;
					return c.json({ ok: true, payload: await store.listCommerceVendorSalesSubscriptions(c.req.param('teamId'), {}) });
				});
	
	app.get('/v1/commerce/vendors/:teamId/sales/entitlements', async (c) => {
					const access = await requireSellerTeamAccess(c, store, c.req.param('teamId'), 'projects:read:team');
					if (access.response) return access.response;
					return c.json({ ok: true, payload: await store.listCommerceVendorSalesEntitlements(c.req.param('teamId'), {
						status: optionalTrimmedString(c.req.query('status')),
					}) });
				});
	
	app.get('/v1/commerce/vendors/:teamId/sales/refunds', async (c) => {
					const access = await requireSellerTeamAccess(c, store, c.req.param('teamId'), 'projects:read:team');
					if (access.response) return access.response;
					return c.json({ ok: true, payload: await store.listCommerceRefunds(access.principal, {
						sellerTeamId: c.req.param('teamId'),
						status: optionalTrimmedString(c.req.query('status')),
					}) });
				});
	
	app.get('/v1/commerce/vendors/:teamId/sales/fulfillment-events', async (c) => {
					const access = await requireSellerTeamAccess(c, store, c.req.param('teamId'), 'projects:read:team');
					if (access.response) return access.response;
					return c.json({ ok: true, payload: await store.listCommerceFulfillmentEvents({
						sellerTeamId: c.req.param('teamId'),
						status: optionalTrimmedString(c.req.query('status')),
					}) });
				});
	
	app.get('/v1/commerce/orders/:orderId/refunds', async (c) => {
					const auth = await ensurePrincipal(c);
					if (auth.response) return auth.response;
					const order = await store.getCommerceOrder(c.req.param('orderId'));
					if (!order) return jsonError(c, 404, `Unknown commerce order "${c.req.param('orderId')}".`);
					if (order.sellerTeamId) {
						const sellerAccess = await requireSellerTeamAccess(c, store, order.sellerTeamId, 'projects:read:team');
						if (!sellerAccess.response || principalIsSeedAdmin(auth.principal)) {
							return c.json({ ok: true, payload: await store.listCommerceRefunds(auth.principal, { orderId: order.id }) });
						}
					}
					if (order.buyerTeamId) {
						const access = await requireTeamAccess(c, store, order.buyerTeamId, 'projects:read:team');
						if (access.response && order.buyerUserId !== auth.principal.id) return access.response;
					} else if (order.buyerUserId && order.buyerUserId !== auth.principal.id && !principalIsSeedAdmin(auth.principal)) {
						return jsonError(c, 403, 'Permission denied.', { orderId: order.id });
					}
					return c.json({ ok: true, payload: await store.listCommerceRefunds(auth.principal, { orderId: order.id }) });
				});
	
	app.post('/v1/commerce/orders/:orderId/refunds', async (c) => {
					const auth = await ensurePrincipal(c);
					if (auth.response) return auth.response;
					const order = await store.getCommerceOrder(c.req.param('orderId'));
					if (!order) return jsonError(c, 404, `Unknown commerce order "${c.req.param('orderId')}".`);
					const access = await requireVendorOrderManager(c, store, order);
					if (access.response) return access.response;
					const vendor = order.sellerTeamId ? await store.getCommerceVendorForTeam(order.sellerTeamId) : null;
					if (!vendor || vendor.status !== 'approved') return jsonError(c, 409, 'Approved vendor status is required before refunds.');
					const body = await c.req.json().catch(() => ({}));
					const idempotencyKey = optionalTrimmedString(body.idempotencyKey) ?? null;
					if (idempotencyKey) {
						const existingRefund = await store.getCommerceRefundByIdempotencyKey(idempotencyKey);
						if (existingRefund) return c.json({ ok: true, payload: existingRefund });
					}
					if (!['paid', 'partially_refunded'].includes(order.status)) return jsonError(c, 409, 'Only paid commerce orders can be refunded.');
					if (!order.stripePaymentIntentId || !order.stripeConnectedAccountId) return jsonError(c, 409, 'Only PaymentIntent-backed one-time orders can be refunded in Phase 6.');
					if (order.stripeSubscriptionId) return jsonError(c, 409, 'Subscription invoice refunds are deferred until invoice payment mapping is modeled.');
					try {
						const orderItem = await resolveOrderItemForRefund(store, order, optionalTrimmedString(body.orderItemId));
						const remaining = remainingRefundableAmount(order, orderItem);
						const amount = body.amount === undefined || body.amount === null ? remaining : Number(body.amount);
						if (!Number.isFinite(amount) || amount <= 0) return jsonError(c, 400, 'Refund amount must be positive.');
						if (amount > remaining) return jsonError(c, 409, 'Refund amount exceeds remaining refundable amount.');
						const finalIdempotencyKey = idempotencyKey ?? `commerce-refund-${order.id}-${orderItem?.id ?? 'order'}-${amount}-${randomUUID()}`;
						let refund = await store.createCommerceRefund({
							orderId: order.id,
							orderItemId: orderItem?.id ?? null,
							vendorId: order.vendorId,
							sellerTeamId: order.sellerTeamId,
							buyerTeamId: order.buyerTeamId,
							buyerUserId: order.buyerUserId,
							amount,
							currency: order.currency,
							status: 'processing',
							reason: optionalTrimmedString(body.reason),
							stripePaymentIntentId: order.stripePaymentIntentId,
							stripeConnectedAccountId: order.stripeConnectedAccountId,
							idempotencyKey: finalIdempotencyKey,
							requestedByType: principalIsSeedAdmin(auth.principal) ? 'operator' : 'user',
							requestedById: auth.principal.id ?? 'system',
							metadata: body.metadata && typeof body.metadata === 'object' ? body.metadata : {},
							actorType: principalIsSeedAdmin(auth.principal) ? 'operator' : 'user',
							actorId: auth.principal.id ?? null,
						});
						const stripeRefund = await stripeConnectService.createRefund({
							connectedAccountId: order.stripeConnectedAccountId,
							idempotencyKey: finalIdempotencyKey,
							params: {
								payment_intent: order.stripePaymentIntentId,
								amount,
								metadata: {
									treeseed_refund_id: refund.id,
									treeseed_order_id: order.id,
									treeseed_order_item_id: orderItem?.id ?? '',
									treeseed_vendor_id: order.vendorId ?? '',
									treeseed_seller_team_id: order.sellerTeamId ?? '',
								},
							},
						});
						if (!stripeRefund) return jsonError(c, 409, 'Stripe is not configured for refunds.');
						refund = await store.updateCommerceRefundFromStripe(refund.id, {
							status: stripeRefundStatus(stripeRefund.status),
							stripeRefundId: stripeRefund.id,
							metadata: { ...refund.metadata, stripeStatus: stripeRefund.status },
							actorType: principalIsSeedAdmin(auth.principal) ? 'operator' : 'user',
							actorId: auth.principal.id ?? null,
						});
						if (refund.status === 'succeeded') {
							await applyCommerceRefundState({
								store,
								order,
								orderItem,
								amount,
								fullRefund: amount >= remainingRefundableAmount(order, null),
							});
						}
						return c.json({ ok: true, payload: { refund, order: await store.getCommerceOrder(order.id), items: await store.listCommerceOrderItems(order.id) } });
					} catch (error) {
						return commerceErrorResponse(c, error);
					}
				});
	
	app.post('/v1/commerce/order-items/:orderItemId/fulfillment/artifact', async (c) => {
					const auth = await ensurePrincipal(c);
					if (auth.response) return auth.response;
					const orderItem = await store.first?.(`SELECT * FROM commerce_order_items WHERE id = ? LIMIT 1`, [c.req.param('orderItemId')]).then((row) => row ? {
						id: row.id,
						orderId: row.order_id,
						vendorId: row.vendor_id,
						sellerTeamId: row.seller_team_id,
						productId: row.product_id,
						productVersionId: row.product_version_id,
						entitlementId: row.entitlement_id,
						status: row.status,
						metadata: row.metadata_json ? JSON.parse(row.metadata_json) : {},
					} : null);
					if (!orderItem) return jsonError(c, 404, `Unknown commerce order item "${c.req.param('orderItemId')}".`);
					const access = await requireTeamAccess(c, store, orderItem.sellerTeamId, 'teams:manage:team');
					if (access.response && !principalIsSeedAdmin(auth.principal)) return access.response;
					if (orderItem.status !== 'paid' && orderItem.status !== 'fulfilled') return jsonError(c, 409, 'Only paid commerce order items can be fulfilled.');
					if (!orderItem.entitlementId) return jsonError(c, 409, 'An active entitlement is required before fulfillment.');
					const entitlement = await store.getCommerceEntitlement(orderItem.entitlementId);
					if (!entitlement || entitlement.status !== 'active') return jsonError(c, 409, 'An active entitlement is required before fulfillment.');
					const body = await c.req.json().catch(() => ({}));
					const resolved = await resolveFulfillmentArtifact({ store, orderItem, body });
					const event = await store.createCommerceFulfillmentEvent({
						orderId: orderItem.orderId,
						orderItemId: orderItem.id,
						entitlementId: entitlement.id,
						vendorId: orderItem.vendorId,
						sellerTeamId: orderItem.sellerTeamId,
						productId: orderItem.productId,
						productVersionId: orderItem.productVersionId,
						catalogItemId: resolved.catalogItemId,
						catalogArtifactVersionId: resolved.artifact?.id ?? optionalTrimmedString(body.catalogArtifactVersionId),
						eventType: 'artifact_delivered',
						status: 'delivered',
						artifactRefs: resolved.artifactRefs,
						deliveryRefs: resolved.deliveryRefs,
						message: optionalTrimmedString(body.message),
						actorType: principalIsSeedAdmin(auth.principal) ? 'operator' : 'user',
						actorId: auth.principal.id ?? 'system',
					});
					await store.markCommerceOrderItemFulfilled(orderItem.id, { metadata: orderItem.metadata });
					const refs = [...(entitlement.fulfillmentArtifactRefs ?? []), ...resolved.deliveryRefs.map((entry) => entry.path ?? entry.url ?? JSON.stringify(entry))];
					const updatedEntitlement = await store.updateCommerceEntitlementFulfillment(entitlement.id, {
						fulfillmentArtifactRefs: refs,
						metadata: entitlement.metadata,
					});
					return c.json({ ok: true, payload: { event, entitlement: updatedEntitlement } });
				});
	
	app.post('/v1/commerce/entitlements/:entitlementId/revoke', async (c) => {
					const auth = await ensurePrincipal(c);
					if (auth.response) return auth.response;
					const entitlement = await store.getCommerceEntitlement(c.req.param('entitlementId'));
					if (!entitlement) return jsonError(c, 404, `Unknown commerce entitlement "${c.req.param('entitlementId')}".`);
					const access = await requireTeamAccess(c, store, entitlement.sellerTeamId, 'teams:manage:team');
					if (access.response && !principalIsSeedAdmin(auth.principal)) return access.response;
					const body = await c.req.json().catch(() => ({}));
					const updated = await store.revokeCommerceEntitlement(entitlement.id, {
						reason: optionalTrimmedString(body.reason),
						renewalState: 'canceled',
						actorType: principalIsSeedAdmin(auth.principal) ? 'operator' : 'user',
						actorId: auth.principal.id ?? null,
					});
					if (entitlement.orderItemId) {
						await store.updateCommerceOrderItemStatus(entitlement.orderItemId, { status: 'revoked' });
					}
					return c.json({ ok: true, payload: updated });
				});
	
	app.get('/v1/commerce/entitlements', async (c) => {
					const auth = await ensurePrincipal(c);
					if (auth.response) return auth.response;
					const filters: Record<string, unknown> = {
						buyerTeamId: optionalTrimmedString(c.req.query('buyerTeamId')),
						productId: optionalTrimmedString(c.req.query('productId')),
						offerId: optionalTrimmedString(c.req.query('offerId')),
						status: optionalTrimmedString(c.req.query('status')),
					};
					if (filters.buyerTeamId && !principalIsSeedAdmin(auth.principal)) {
						const access = await requireTeamAccess(c, store, filters.buyerTeamId, 'projects:read:team');
						if (access.response) return access.response;
					}
					if (!filters.buyerTeamId && !principalIsSeedAdmin(auth.principal)) {
						filters.buyerUserId = auth.principal.id;
					}
					return c.json({ ok: true, payload: await store.listCommerceEntitlements(auth.principal, filters) });
				});
	
	app.get('/v1/commerce/entitlements/:entitlementId', async (c) => {
					const auth = await ensurePrincipal(c);
					if (auth.response) return auth.response;
					const entitlement = await store.getCommerceEntitlement(c.req.param('entitlementId'));
					if (!entitlement) return jsonError(c, 404, `Unknown commerce entitlement "${c.req.param('entitlementId')}".`);
					if (entitlement.buyerTeamId && !principalIsSeedAdmin(auth.principal)) {
						const access = await requireTeamAccess(c, store, entitlement.buyerTeamId, 'projects:read:team');
						if (access.response && entitlement.buyerUserId !== auth.principal.id) return access.response;
					} else if (entitlement.buyerUserId && entitlement.buyerUserId !== auth.principal.id && !principalIsSeedAdmin(auth.principal)) {
						return jsonError(c, 403, 'Permission denied.', { entitlementId: entitlement.id });
					}
					return c.json({ ok: true, payload: entitlement });
				});
	
	app.post('/v1/commerce/webhooks/stripe', async (c) => {
					const webhookSecret = resolveStripeWebhookSecret(runtime.resolved.config);
					if (!webhookSecret) return jsonError(c, 409, 'Stripe webhook verification is not configured for this market.');
					const signature = c.req.header('stripe-signature');
					if (!signature) return jsonError(c, 400, 'Stripe-Signature header is required.');
					const payload = await c.req.text();
					try {
						const event = await stripeConnectService.constructWebhookEvent({ payload, signature, webhookSecret });
						const environment = stripeConnectService.environment ?? resolveStripeEnvironment(runtime.resolved.config);
						const object = event?.data?.object ?? {};
						const webhook = await store.recordCommerceWebhookEvent({
							provider: 'stripe',
							environment,
							eventId: event.id,
							eventType: event.type,
							connectedAccountId: optionalTrimmedString(event.account) ?? optionalTrimmedString(event.context) ?? null,
							status: 'received',
							objectType: object.object ?? null,
							objectId: object.id ?? null,
							payloadHash: createHash('sha256').update(payload).digest('hex'),
						});
						if (webhook.status === 'processed' || webhook.status === 'ignored') {
							return c.json({ ok: true, payload: webhook });
						}
						const claimed = await store.claimCommerceWebhookEvent(webhook.id);
						if (!claimed || claimed.status === 'processed') return c.json({ ok: true, payload: claimed ?? webhook });
						const result = await processCommerceStripeWebhook({ store, stripeConnectService, event });
						const updated = result.ignored
							? await store.markCommerceWebhookEventIgnored(webhook.id, {
								processingError: result.reason,
								relatedOrderId: result.relatedOrderId,
								relatedSubscriptionId: result.relatedSubscriptionId,
							})
							: await store.markCommerceWebhookEventProcessed(webhook.id, {
								relatedOrderId: result.relatedOrderId,
								relatedSubscriptionId: result.relatedSubscriptionId,
							});
						return c.json({ ok: true, payload: updated });
					} catch (error) {
						return commerceErrorResponse(c, error);
					}
				});
	
	app.get('/v1/commerce/products', async (c) => {
					return c.json({
						ok: true,
						payload: await store.listCommerceProducts(c.get('principal'), {
							teamId: optionalTrimmedString(c.req.query('teamId')),
							vendorId: optionalTrimmedString(c.req.query('vendorId')),
							kind: optionalTrimmedString(c.req.query('kind')),
							status: optionalTrimmedString(c.req.query('status')),
							slug: optionalTrimmedString(c.req.query('slug')),
						}),
					});
				});
	
	app.post('/v1/commerce/products', async (c) => {
					const body = await c.req.json().catch(() => ({}));
					const sellerTeamId = optionalTrimmedString(body.sellerTeamId);
					if (!sellerTeamId) return jsonError(c, 400, 'sellerTeamId is required.');
					const access = await requireTeamAccess(c, store, sellerTeamId, 'teams:manage:team');
					if (access.response) return access.response;
					try {
						return c.json({
							ok: true,
							payload: await store.createCommerceProductDraft(sellerTeamId, {
								id: optionalTrimmedString(body.id),
								kind: optionalTrimmedString(body.kind),
								slug: optionalTrimmedString(body.slug),
								title: optionalTrimmedString(body.title),
								summary: optionalTrimmedString(body.summary),
								description: optionalTrimmedString(body.description),
								visibility: optionalTrimmedString(body.visibility),
								ownershipModel: optionalTrimmedString(body.ownershipModel),
								ownership: body.ownership && typeof body.ownership === 'object' ? body.ownership : undefined,
								supportPolicy: optionalTrimmedString(body.supportPolicy),
								license: optionalTrimmedString(body.license),
								metadata: body.metadata && typeof body.metadata === 'object' ? body.metadata : {},
							}),
						});
					} catch (error) {
						return commerceErrorResponse(c, error);
					}
				});
	
	app.get('/v1/commerce/products/:productId', async (c) => {
					const access = await requireCommerceProductAccess(c, store, c.req.param('productId'));
					if (access.response) return access.response;
					return c.json({ ok: true, payload: access.product });
				});
	
	app.patch('/v1/commerce/products/:productId', async (c) => {
					const access = await requireCommerceProductAccess(c, store, c.req.param('productId'), 'teams:manage:team');
					if (access.response) return access.response;
					const body = await c.req.json().catch(() => ({}));
					try {
						return c.json({
							ok: true,
							payload: await store.updateCommerceProduct(access.product.id, {
								kind: optionalTrimmedString(body.kind),
								slug: optionalTrimmedString(body.slug),
								title: optionalTrimmedString(body.title),
								summary: body.summary === undefined ? undefined : optionalTrimmedString(body.summary),
								description: body.description === undefined ? undefined : optionalTrimmedString(body.description),
								visibility: optionalTrimmedString(body.visibility),
								ownershipModel: optionalTrimmedString(body.ownershipModel),
								supportPolicy: body.supportPolicy === undefined ? undefined : optionalTrimmedString(body.supportPolicy),
								license: body.license === undefined ? undefined : optionalTrimmedString(body.license),
								metadata: body.metadata && typeof body.metadata === 'object' ? body.metadata : undefined,
							}),
						});
					} catch (error) {
						return commerceErrorResponse(c, error);
					}
				});
	
	app.post('/v1/commerce/products/:productId/submit', async (c) => {
					const access = await requireCommerceProductAccess(c, store, c.req.param('productId'), 'teams:manage:team');
					if (access.response) return access.response;
					const body = await c.req.json().catch(() => ({}));
					try {
						return c.json({ ok: true, payload: await store.submitCommerceProduct(access.product.id, {
							reason: optionalTrimmedString(body.reason),
							evidence: body.evidence && typeof body.evidence === 'object' ? body.evidence : {},
							actorType: 'user',
							actorId: access.principal.id ?? null,
						}) });
					} catch (error) {
						return commerceErrorResponse(c, error);
					}
				});
	
	app.post('/v1/commerce/products/:productId/approve', async (c) => {
					const auth = await ensurePrincipal(c);
					if (auth.response) return auth.response;
					if (!principalIsSeedAdmin(auth.principal)) return jsonError(c, 403, 'Permission denied.', { permission: 'commerce:approve:global' });
					const body = await c.req.json().catch(() => ({}));
					try {
						const product = await store.approveCommerceProduct(c.req.param('productId'), {
							reason: optionalTrimmedString(body.reason),
							evidence: body.evidence && typeof body.evidence === 'object' ? body.evidence : {},
							actorType: 'operator',
							actorId: auth.principal.id ?? null,
						});
						if (!product) return jsonError(c, 404, `Unknown commerce product "${c.req.param('productId')}".`);
						return c.json({ ok: true, payload: product });
					} catch (error) {
						return commerceErrorResponse(c, error);
					}
				});
	
	app.post('/v1/commerce/products/:productId/ownership', async (c) => {
					const access = await requireCommerceProductAccess(c, store, c.req.param('productId'), 'teams:manage:team');
					if (access.response) return access.response;
					const body = await c.req.json().catch(() => ({}));
					const ownership = await store.createCommerceOwnershipRecord(access.product.id, body);
					await store.setCurrentCommerceOwnershipRecord(access.product.id, ownership.id);
					return c.json({ ok: true, payload: ownership });
				});
}
