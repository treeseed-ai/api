export function installProjectsProjectsItemProposalsThroughProjectsItemDecisionsItemEventsRoutes(context: any) {
	const { AGENT_PROMOTION_APPROVAL_DECISIONS, AGENT_TASK_SIGNATURES, AUTH_PROVIDERS, AgentSdk, CHECKOUT_COMMERCIAL_OFFER_MODES, CHECKOUT_OFFER_MODES, CHECKOUT_SUBSCRIPTION_OFFER_MODES, DatabaseAuthProvider, FEEDBACK_SCREENSHOT_TYPES, FEEDBACK_TYPES, GITHUB_ACTIONS_OIDC_ISSUER, HOST_KIND_SESSION_KEYS, LOCAL_CONTENT_COLLECTIONS, LOCAL_CONTENT_DEFAULTS, LOCAL_DECISION_TYPE_VALUES, LOCAL_WORK_CONTENT_COLLECTIONS, MARKET_EMAIL_CONFIRMATION_PREFIX, MAX_FEEDBACK_MESSAGE_LENGTH, MAX_FEEDBACK_SCREENSHOT_BYTES, MarketControlPlaneStore, NOTIFICATION_CONTENT_CAPABILITIES, PERSONAL_THEME_COMPILER_VERSION, PLAINTEXT_HOST_CREDENTIAL_FIELD_NAMES, PLATFORM_OPERATION_SCOPES, POSTGRES_AUTH_PROVIDER_ID, PROPOSAL_VERDICT_DECISION_TYPES, RemoteTreeseedClient, RemoteTreeseedOperationsClient, RemoteTreeseedSdkClient, SENSITIVE_QUERY_PARAM_PATTERN, STRIPE_PRICE_MIRROR_OFFER_MODES, STRIPE_PRODUCT_MIRROR_OFFER_MODES, TreeseedOperationsSdk, accountDeletionBlockers, accountDeletionConfirmationMatches, addRelationValue, apiDatabaseUrl, app, appendLaunchDeploymentEvent, appendLaunchPhaseProjection, appendProjectDeletionProgress, applyCommerceRefundState, applyContentPublishResult, applyHubLaunchFailure, applyHubLaunchResult, applySeedWithStore, artifactDownloadPayload, authConfig, authEmailDeliveryFailureDetail, authEmailDeliveryFailureReason, authProviderId, authTokenTimestampMillis, authTokenTimestampSeconds, availabilityAttempts, availabilityRateLimit, backfillUserEmailAddresses, base64Url, base64urlJson, bearerTokenFromRequest, buildCommerceCheckoutMetadata, buildCommerceStripeMetadata, buildGovernanceApprovalProjection, buildGovernanceProjection, buildInfrastructureProjection, buildKnowledgeArtifactProjection, buildKnowledgeProjection, buildLaunchCredentialOverlay, buildWorkdayProjection, canSkipCloudflareCleanupAfterFailedLaunch, canonicalArchitectureTopology, capacity, centralMarketProfile, checkoutGroupKey, checkoutGroupKind, checkoutGroupStatus, ciOperationForAction, cleanFeedbackString, cloudflareDeletionAuthenticationMessage, cloudflareDnsDomainsForHostValidation, cloudflareErrorMessage, cloudflareProjectDeletionResourceNames, cloudflareRequestForLaunchPreflight, cloudflareRequestForProjectDeletion, collectHostingAuditCredentialOverlay, commerceCheckoutError, commerceErrorResponse, commerceStripeLookupKey, commerceStripePriceParams, commerceStripeProductParams, commerceStripeSyncContext, config, configuredAuthProviderId, confirmationUrlFor, consumeReauthentication, contentRelationPolicy, createApiApp, createApiExtension, createCapacityControlPlane, createCipheriv, createClientEncryptedEscrowService, createCommerceCheckoutRun, createCommerceCheckoutRunForServiceContract, createDecipheriv, createDecisionFromProposals, createGitHubActionsSecretEnclave, createGitHubAppAdapter, createHash, createHmac, createMarketEmailConfirmation, createMarketPostgresDatabase, createMarketWebSession, createOrResendUserEmailAddress, createProjectHostCredentialSessions, createProjectInternalClient, createPublicKey, createRelatedLocalContentRecord, createStripeConnectService, createTreeDxCredentialBridge, createTreeseedApiApp, createVerify, credentialSessionKey, credentialSessionSecret, db, decodeRouteParam, decorateJob, decoratePlatformOperation, decryptCredentialSessionPayload, decryptHostConfig, decryptTeamHostForLaunch, decryptedHostConfigSummary, defaultConfig, deleteCloudflareDnsRecordsForProject, deleteCloudflareProjectResources, deleteTeamCapacityAggregate, derivePlatformOperationNavigation, deriveProjectHostBindingsView, domainInZone, encryptCredentialSessionPayload, encryptedHostPayloadLooksValid, enqueueTreeDxProvisionOperation, ensureCommerceStripeCustomer, ensureMarketCredentialSchema, ensurePrincipal, entitlementRenewalStateFromSubscription, enumValue, exchangeProviderIdentity, executeInline, executeProjectApi, executeSdkOperation, existsSync, exportSeedWithStore, exposeAuthTokenForTests, fallbackRemoteCapability, findById, findDispatchCapability, getSiteAuthConfig, getUserEmailAddress, githubOidcJwksCache, githubRequestForProjectDeletion, grantCommerceEntitlementsForOrder, handleCommerceInvoiceWebhook, handleCommercePaymentIntentWebhook, handleCommerceSubscriptionWebhook, hasRecordedCloudflareRuntimeResources, hashMarketPassword, hostBindingRequiresUnlock, hostKindForBinding, hubRepositoryPolicies, inferZoneNameForDomain, installApiRequestLogger, installCapacityRoutes, installProjectDeploymentRoutes, isLocalAcceptanceServicePrincipal, isLoopbackUrl, isPlatformOperationTerminal, isTeamApiPrincipal, isValidPersonalThemeDraft, jsonError, jsonThrownError, launchCapabilityPreset, launchPlannerRepositoryTopology, listCloudflareNamedResources, listTreeseedManagedHostsFromConfig, listUserEmailAddresses, loadGitHubOidcJwks, loadInfrastructureSeedState, loadKnowledgeContentEntries, loadNotificationPreferences, loadProjectHostBindingContext, loadTemplateCatalog, localAcceptanceAdminToken, localAcceptanceAuthEnabled, localContentPath, localContentRoot, logRequests, managedCloudflareConfigMissing, markdownToPlainProjectSummary, marketAuthContext, marketEmailTokenHash, marketProfilesForTeams, mergeCapability, mergeStringConfig, mkdir, nonSecretLaunchJobInput, normalizeAppearancePreference, normalizeAuditHostKinds, normalizeBaseUrl, normalizeCheckoutQuantity, normalizeCiEnvironment, normalizeDomainName, normalizeEmail, normalizeLocalContentInput, normalizeMarketProfile, normalizeNotificationPreferences, normalizeProjectDomainInput, normalizeProjectLaunchHostBindings, normalizeProviderCredentialConfig, normalizeRelationArray, normalizeRepositoryContentInput, normalizeRepositoryRelationArray, normalizeRepositorySlug, normalizeSeedEnvironments, normalizeTemplateLaunchRequirements, normalizeTreeseedTemplateId, normalizeUsername, normalizedCloudflareKvNamespaceReference, operationTokenSecret, optionalTrimmedString, orderStatusFromPaymentGroup, parseBase64urlJson, parseBooleanEnvValue, parseJsonObject, parseYaml, passwordResetUrlFor, patchLaunchIntentForCredentialOverlay, paymentGroupStatusFromPaymentIntent, pbkdf2Sync, persistProjectHostBindingOperationMetadata, personalThemeFromRow, plaintextHostCredentialFieldPaths, planKnowledgeHubLaunch, planProjectHostBindingOperation, planSeedWithStore, platformOperationMutationError, principalCanManageCommerceProduct, principalHasGlobalPlatformRole, principalHasPermission, principalIsSeedAdmin, privateKnowledgeAuditPayload, processCommerceStripeWebhook, projectAllowedCiRepositories, projectApiConnection, projectAppHref, projectDeletionBlockerRows, projectDeletionConfirmationMatches, projectDeletionHostname, projectDeletionOperation, projectHostBindingMetadata, projectHostResponsePayload, providerConfigFor, providerCredentialValuesForAudit, providerJwksCache, publicPaymentGroups, randomBytes, randomUUID, readCapacityRequestObject, readFile, readJsonOrFormBody, readLocalContentRecord, recordContentNotificationEvent, recordFeedbackSubmission, recordPrivateKnowledgeAudit, redactCommerceOwnershipWorkflow, redactCommerceServiceRequestForBuyer, redactedRequestTarget, refreshCommercePaymentGroupState, refreshCommerceStripeAccount, rejectPlaintextHostCredentialFields, rejectProjectSecretUnlockMaterial, relative, remainingRefundableAmount, repositoryContentRelationPolicy, repositoryInventoryWithPlatform, requestClientIp, requestSessionMetadata, requireCatalogItemAccess, requireCommerceCapacityInquiryAccess, requireCommerceCapacityListingAccess, requireCommerceOfferAccess, requireCommerceProductAccess, requireCommerceVendorForStripe, requireConfiguredServiceCredential, requireConnectedProjectRuntime, requirePlatformRunner, requireProjectAccess, requireProjectRunner, requireSeedApplyAccess, requireSeedPlanAccess, requireSellerTeamAccess, requireServiceBuyerAccess, requireServiceParticipantAccess, requireServiceSellerAccess, requireTeamAccess, requireVendorOrderManager, resolve, resolveAgentArtifactBucket, resolveAgentTaskSignature, resolveApiConfig, resolveAuthApprovalBaseUrl, resolveCloudflareZoneForLaunchPreflight, resolveCommerceCheckoutItem, resolveFulfillmentArtifact, resolveLaunchTemplateRequirements, resolveOrderItemForRefund, resolvePlatformRepositoryDescriptor, resolvePlatformRunnerSecret, resolveProjectDeletionCloudflareZone, resolveProjectLaunchHostBindings, resolvePublicTreeDxTeam, resolveStripeEnvironment, resolveStripePublishableKey, resolveStripeWebhookSecret, resolveTreeseedManagedCloudflareHostConfigFromConfig, resolveUiProjectionContext, resourceRowsFromLaunch, retryApiLaunchBootstrapFromRequest, rm, runProjectDeletionApiDestroy, runProjectLaunchApiBootstrap, runTreeseedHostingAudit, runtime, runtimeMarketAuthProvider, runtimeProviders, safeFeedbackClient, safeFeedbackContext, safeFeedbackScreenshot, safePlatformOperationOutput, safePrivateKnowledgeSlug, safeTokenEquals, sanitizeLaunchResultForStorage, sanitizedReturnTo, scheduleBackgroundBootstrap, seedActor, seedCreatesMissingTeams, seedExistingTeamIds, selectDispatchTarget, sendAuthEmail, sendEmailConfirmation, sendTeamInviteEmail, sendWelcomeEmail, serializeFrontmatter, serializeUserEmailAddress, setPrimaryEmailAddress, sharedSdk, shouldBypassAcceptanceAuthEmailDelivery, shouldExposeNonProductionAuthDiagnostics, shouldLogApiRequests, signEditorialPreviewToken, signOperationToken, slugifyContent, slugifyRepositoryContent, sourceFromProjectDetails, store, stripeAccountMissingError, stripeAccountToConnectedAccountPatch, stripeClientSecret, stripeCommerceUrl, stripeConfiguredError, stripeConnectService, stripeMetadataValue, stripePriceTermsDrift, stripeRefundStatus, stripeTimestampToIso, stripeVendorApprovalError, subscriptionClientSecret, subscriptionStatusFromStripe, syncCommerceOfferStripeProduct, syncCommercePriceStripePrice, syncCommerceSubscriptionFromStripe, syncPrimaryEmailCaches, teamInviteAcceptUrlFor, timingSafeEqual, trimmedHeaderValue, uiRuntimeLocals, uniqueCloudflareKvNamespaceReferences, uniqueRelationArray, unknownKeys, unwrapLaunchOperationOutput, unwrapOperationPayload, updateCheckoutCompletionFromGroup, updateLaunchDeployments, validateCiRefForEnvironment, validateFeedbackAccess, validateMarketPassword, validateProjectSlug, validatePublicUsername, validateTeamHostCredentialPayload, verifiedEmailCount, verifyCloudflareDnsWriteForLaunch, verifyGitHubOidcToken, verifyMarketPassword, verifyOperationToken, verifyProviderIdToken, webAuthPayload, webSessionData, writeFile, writeLocalContentRecord, writeParsedLocalContentRecord, yamlLines, yamlScalar } = context;
	app.get('/v1/projects/:projectId/proposals', async (c) => {
					const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:read:team');
					if (access.response) return access.response;
					return c.json({ ok: true, payload: await store.listGovernanceProposals({
						projectId: access.details.project.id,
						status: optionalTrimmedString(c.req.query('status')),
						limit: c.req.query('limit'),
					}) });
				});
	
	app.post('/v1/projects/:projectId/proposals', async (c) => {
					const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:manage:team');
					if (access.response) return access.response;
					const body = await readJsonOrFormBody(c);
					try {
						return c.json({ ok: true, payload: await store.createGovernanceProposal(access.principal, {
							...body,
							teamId: access.details.project.teamId,
							projectId: access.details.project.id,
							scope: 'project',
							createdByType: isTeamApiPrincipal(access.principal) ? 'team_api_key' : c.get('actorType') === 'service' ? 'service' : 'user',
							createdById: access.principal.id,
						}) }, { status: 201 });
					} catch (error) {
						return jsonThrownError(c, error, 400);
					}
				});
	
	app.get('/v1/projects/:projectId/proposals/:proposalId', async (c) => {
					const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:read:team');
					if (access.response) return access.response;
					const proposal = await store.getGovernanceProposal(c.req.param('proposalId'));
					if (!proposal || proposal.projectId !== access.details.project.id) return jsonError(c, 404, 'Unknown governance proposal.');
					return c.json({ ok: true, payload: {
						...proposal,
						votes: await store.listGovernanceProposalVotes(proposal.id),
						events: await store.listGovernanceEvents({ proposalId: proposal.id, limit: 100 }),
						decision: proposal.decisionId ? await store.getGovernanceDecision(proposal.decisionId) : null,
					} });
				});
	
	app.patch('/v1/projects/:projectId/proposals/:proposalId', async (c) => {
					const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:manage:team');
					if (access.response) return access.response;
					const proposal = await store.getGovernanceProposal(c.req.param('proposalId'));
					if (!proposal || proposal.projectId !== access.details.project.id) return jsonError(c, 404, 'Unknown governance proposal.');
					const body = await readJsonOrFormBody(c);
					try {
						return c.json({ ok: true, payload: await store.updateGovernanceProposalDraft(access.principal, proposal.id, body) });
					} catch (error) {
						return jsonThrownError(c, error, 400);
					}
				});
	
	app.post('/v1/projects/:projectId/proposals/:proposalId/open', async (c) => {
					const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:manage:team');
					if (access.response) return access.response;
					const body = await readJsonOrFormBody(c);
					const proposal = await store.openGovernanceProposal(access.principal, c.req.param('proposalId'), body);
					if (!proposal || proposal.projectId !== access.details.project.id) return jsonError(c, 404, 'Unknown governance proposal.');
					return c.json({ ok: true, payload: proposal });
				});
	
	app.post('/v1/projects/:projectId/proposals/:proposalId/start-voting', async (c) => {
					const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:manage:team');
					if (access.response) return access.response;
					const body = await readJsonOrFormBody(c);
					try {
						const proposal = await store.startGovernanceProposalVoting(access.principal, c.req.param('proposalId'), body);
						if (!proposal || proposal.projectId !== access.details.project.id) return jsonError(c, 404, 'Unknown governance proposal.');
						return c.json({ ok: true, payload: proposal });
					} catch (error) {
						return jsonThrownError(c, error, 400);
					}
				});
	
	app.post('/v1/projects/:projectId/proposals/:proposalId/vote', async (c) => {
					const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:read:team');
					if (access.response) return access.response;
					const existing = await store.getGovernanceProposal(c.req.param('proposalId'));
					if (!existing || existing.projectId !== access.details.project.id) return jsonError(c, 404, 'Unknown governance proposal.');
					const body = await readJsonOrFormBody(c);
					try {
						return c.json({ ok: true, payload: await store.voteGovernanceProposal(access.principal, existing.id, body) });
					} catch (error) {
						return jsonThrownError(c, error, 400);
					}
				});
	
	app.post('/v1/projects/:projectId/proposals/:proposalId/evaluate', async (c) => {
					const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:manage:team');
					if (access.response) return access.response;
					const existing = await store.getGovernanceProposal(c.req.param('proposalId'));
					if (!existing || existing.projectId !== access.details.project.id) return jsonError(c, 404, 'Unknown governance proposal.');
					const body = await readJsonOrFormBody(c);
					return c.json({ ok: true, payload: await store.evaluateGovernanceProposal(existing.id, {
						...body,
						actorType: isTeamApiPrincipal(access.principal) ? 'team_api_key' : c.get('actorType') === 'service' ? 'service' : 'user',
						actorId: access.principal.id,
					}) });
				});
	
	app.post('/v1/projects/:projectId/proposals/:proposalId/admin-decision', async (c) => {
					const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'teams:manage:team');
					if (access.response) return access.response;
					const existing = await store.getGovernanceProposal(c.req.param('proposalId'));
					if (!existing || existing.projectId !== access.details.project.id) return jsonError(c, 404, 'Unknown governance proposal.');
					const body = await readJsonOrFormBody(c);
					try {
						return c.json({ ok: true, payload: await store.adminDecideGovernanceProposal(access.principal, existing.id, body) });
					} catch (error) {
						return jsonThrownError(c, error, 400);
					}
				});
	
	app.post('/v1/projects/:projectId/proposals/:proposalId/withdraw', async (c) => {
					const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:manage:team');
					if (access.response) return access.response;
					const existing = await store.getGovernanceProposal(c.req.param('proposalId'));
					if (!existing || existing.projectId !== access.details.project.id) return jsonError(c, 404, 'Unknown governance proposal.');
					const body = await readJsonOrFormBody(c);
					return c.json({ ok: true, payload: await store.withdrawGovernanceProposal(access.principal, existing.id, body) });
				});
	
	app.post('/v1/projects/:projectId/proposals/:proposalId/supersede', async (c) => {
					const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:manage:team');
					if (access.response) return access.response;
					const existing = await store.getGovernanceProposal(c.req.param('proposalId'));
					if (!existing || existing.projectId !== access.details.project.id) return jsonError(c, 404, 'Unknown governance proposal.');
					const body = await readJsonOrFormBody(c);
					return c.json({ ok: true, payload: await store.supersedeGovernanceProposal(access.principal, existing.id, body) });
				});
	
	app.get('/v1/projects/:projectId/proposals/:proposalId/events', async (c) => {
					const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:read:team');
					if (access.response) return access.response;
					const proposal = await store.getGovernanceProposal(c.req.param('proposalId'));
					if (!proposal || proposal.projectId !== access.details.project.id) return jsonError(c, 404, 'Unknown governance proposal.');
					return c.json({ ok: true, payload: await store.listGovernanceEvents({ proposalId: proposal.id, limit: c.req.query('limit') }) });
				});
	
	app.get('/v1/projects/:projectId/decisions', async (c) => {
					const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:read:team');
					if (access.response) return access.response;
					return c.json({ ok: true, payload: await store.listGovernanceDecisions({
						projectId: access.details.project.id,
						status: optionalTrimmedString(c.req.query('status')),
						limit: c.req.query('limit'),
					}) });
				});
	
	app.get('/v1/projects/:projectId/decisions/:decisionId', async (c) => {
					const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:read:team');
					if (access.response) return access.response;
					const decision = await store.getGovernanceDecision(c.req.param('decisionId'));
					if (!decision || decision.projectId !== access.details.project.id) return jsonError(c, 404, 'Unknown governance decision.');
					return c.json({ ok: true, payload: decision });
				});
	
	app.get('/v1/projects/:projectId/decisions/:decisionId/events', async (c) => {
					const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:read:team');
					if (access.response) return access.response;
					const decision = await store.getGovernanceDecision(c.req.param('decisionId'));
					if (!decision || decision.projectId !== access.details.project.id) return jsonError(c, 404, 'Unknown governance decision.');
					return c.json({ ok: true, payload: await store.listGovernanceEvents({ decisionId: decision.id, limit: c.req.query('limit') }) });
				});
}
