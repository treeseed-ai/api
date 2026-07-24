export function installGovernanceCommonsProposalsQuestionsAndVotesRoutes(context: any) {
	const { AGENT_PROMOTION_APPROVAL_DECISIONS, AGENT_TASK_SIGNATURES, AUTH_PROVIDERS, AgentSdk, CHECKOUT_COMMERCIAL_OFFER_MODES, CHECKOUT_OFFER_MODES, CHECKOUT_SUBSCRIPTION_OFFER_MODES, DatabaseAuthProvider, FEEDBACK_SCREENSHOT_TYPES, FEEDBACK_TYPES, GITHUB_ACTIONS_OIDC_ISSUER, HOST_KIND_SESSION_KEYS, LOCAL_CONTENT_COLLECTIONS, LOCAL_CONTENT_DEFAULTS, LOCAL_DECISION_TYPE_VALUES, LOCAL_WORK_CONTENT_COLLECTIONS, MARKET_EMAIL_CONFIRMATION_PREFIX, MAX_FEEDBACK_MESSAGE_LENGTH, MAX_FEEDBACK_SCREENSHOT_BYTES, MarketControlPlaneStore, NOTIFICATION_CONTENT_CAPABILITIES, PERSONAL_THEME_COMPILER_VERSION, PLAINTEXT_HOST_CREDENTIAL_FIELD_NAMES, PLATFORM_OPERATION_SCOPES, POSTGRES_AUTH_PROVIDER_ID, PROPOSAL_VERDICT_DECISION_TYPES, RemoteClient, RemoteOperationsClient, RemoteSdkClient, SENSITIVE_QUERY_PARAM_PATTERN, STRIPE_PRICE_MIRROR_OFFER_MODES, STRIPE_PRODUCT_MIRROR_OFFER_MODES, OperationsSdk, accountDeletionBlockers, accountDeletionConfirmationMatches, addRelationValue, apiDatabaseUrl, app, appendLaunchDeploymentEvent, appendLaunchPhaseProjection, appendProjectDeletionProgress, applyCommerceRefundState, applyContentPublishResult, applyHubLaunchFailure, applyHubLaunchResult, applySeedWithStore, artifactDownloadPayload, authConfig, authEmailDeliveryFailureDetail, authEmailDeliveryFailureReason, authProviderId, authTokenTimestampMillis, authTokenTimestampSeconds, availabilityAttempts, availabilityRateLimit, backfillUserEmailAddresses, base64Url, base64urlJson, bearerTokenFromRequest, buildCommerceCheckoutMetadata, buildCommerceStripeMetadata, buildGovernanceApprovalProjection, buildGovernanceProjection, buildInfrastructureProjection, buildKnowledgeArtifactProjection, buildKnowledgeProjection, buildLaunchCredentialOverlay, buildWorkdayProjection, canSkipCloudflareCleanupAfterFailedLaunch, canonicalArchitectureTopology, capacity, centralMarketProfile, checkoutGroupKey, checkoutGroupKind, checkoutGroupStatus, ciOperationForAction, cleanFeedbackString, cloudflareDeletionAuthenticationMessage, cloudflareDnsDomainsForHostValidation, cloudflareErrorMessage, cloudflareProjectDeletionResourceNames, cloudflareRequestForLaunchPreflight, cloudflareRequestForProjectDeletion, collectHostingAuditCredentialOverlay, commerceCheckoutError, commerceErrorResponse, commerceStripeLookupKey, commerceStripePriceParams, commerceStripeProductParams, commerceStripeSyncContext, config, configuredAuthProviderId, confirmationUrlFor, consumeReauthentication, contentRelationPolicy, createApiExtension, createCapacityControlPlane, createCipheriv, createClientEncryptedEscrowService, createCommerceCheckoutRun, createCommerceCheckoutRunForServiceContract, createDecipheriv, createDecisionFromProposals, createGitHubActionsSecretEnclave, createGitHubAppAdapter, createHash, createHmac, createMarketEmailConfirmation, createMarketPostgresDatabase, createMarketWebSession, createOrResendUserEmailAddress, createProjectHostCredentialSessions, createProjectInternalClient, createPublicKey, createRelatedLocalContentRecord, createStripeConnectService, createTreeDxCredentialBridge, createVerify, credentialSessionKey, credentialSessionSecret, db, decodeRouteParam, decorateJob, decoratePlatformOperation, decryptCredentialSessionPayload, decryptHostConfig, decryptTeamHostForLaunch, decryptedHostConfigSummary, defaultConfig, deleteCloudflareDnsRecordsForProject, deleteCloudflareProjectResources, deleteTeamCapacityAggregate, derivePlatformOperationNavigation, deriveProjectHostBindingsView, domainInZone, encryptCredentialSessionPayload, encryptedHostPayloadLooksValid, enqueueTreeDxProvisionOperation, ensureCommerceStripeCustomer, ensureMarketCredentialSchema, ensurePrincipal, entitlementRenewalStateFromSubscription, enumValue, exchangeProviderIdentity, executeInline, executeProjectApi, executeSdkOperation, existsSync, exportSeedWithStore, exposeAuthTokenForTests, fallbackRemoteCapability, findById, findDispatchCapability, getSiteAuthConfig, getUserEmailAddress, githubOidcJwksCache, githubRequestForProjectDeletion, grantCommerceEntitlementsForOrder, handleCommerceInvoiceWebhook, handleCommercePaymentIntentWebhook, handleCommerceSubscriptionWebhook, hasRecordedCloudflareRuntimeResources, hashMarketPassword, hostBindingRequiresUnlock, hostKindForBinding, hubRepositoryPolicies, inferZoneNameForDomain, installApiRequestLogger, installCapacityRoutes, installProjectDeploymentRoutes, isLocalAcceptanceServicePrincipal, isLoopbackUrl, isPlatformOperationTerminal, isTeamApiPrincipal, isValidPersonalThemeDraft, jsonError, jsonThrownError, launchCapabilityPreset, launchPlannerRepositoryTopology, listCloudflareNamedResources, listManagedHostsFromConfig, listUserEmailAddresses, loadGitHubOidcJwks, loadInfrastructureSeedState, loadKnowledgeContentEntries, loadNotificationPreferences, loadProjectHostBindingContext, loadTemplateCatalog, localAcceptanceAdminToken, localAcceptanceAuthEnabled, localContentPath, localContentRoot, logRequests, managedCloudflareConfigMissing, markdownToPlainProjectSummary, marketAuthContext, marketEmailTokenHash, marketProfilesForTeams, mergeCapability, mergeStringConfig, mkdir, nonSecretLaunchJobInput, normalizeAppearancePreference, normalizeAuditHostKinds, normalizeBaseUrl, normalizeCheckoutQuantity, normalizeCiEnvironment, normalizeDomainName, normalizeEmail, normalizeLocalContentInput, normalizeMarketProfile, normalizeNotificationPreferences, normalizeProjectDomainInput, normalizeProjectLaunchHostBindings, normalizeProviderCredentialConfig, normalizeRelationArray, normalizeRepositoryContentInput, normalizeRepositoryRelationArray, normalizeRepositorySlug, normalizeSeedEnvironments, normalizeTemplateLaunchRequirements, normalizeTemplateId, normalizeUsername, normalizedCloudflareKvNamespaceReference, operationTokenSecret, optionalTrimmedString, orderStatusFromPaymentGroup, parseBase64urlJson, parseBooleanEnvValue, parseJsonObject, parseYaml, passwordResetUrlFor, patchLaunchIntentForCredentialOverlay, paymentGroupStatusFromPaymentIntent, pbkdf2Sync, persistProjectHostBindingOperationMetadata, personalThemeFromRow, plaintextHostCredentialFieldPaths, planKnowledgeHubLaunch, planProjectHostBindingOperation, planSeedWithStore, platformOperationMutationError, principalCanManageCommerceProduct, principalHasGlobalPlatformRole, principalHasPermission, principalIsSeedAdmin, privateKnowledgeAuditPayload, processCommerceStripeWebhook, projectAllowedCiRepositories, projectApiConnection, projectAppHref, projectDeletionBlockerRows, projectDeletionConfirmationMatches, projectDeletionHostname, projectDeletionOperation, projectHostBindingMetadata, projectHostResponsePayload, providerConfigFor, providerCredentialValuesForAudit, providerJwksCache, publicPaymentGroups, randomBytes, randomUUID, readCapacityRequestObject, readFile, readJsonOrFormBody, readLocalContentRecord, recordContentNotificationEvent, recordFeedbackSubmission, recordPrivateKnowledgeAudit, redactCommerceOwnershipWorkflow, redactCommerceServiceRequestForBuyer, redactedRequestTarget, refreshCommercePaymentGroupState, refreshCommerceStripeAccount, rejectPlaintextHostCredentialFields, rejectProjectSecretUnlockMaterial, relative, remainingRefundableAmount, repositoryContentRelationPolicy, repositoryInventoryWithPlatform, requestClientIp, requestSessionMetadata, requireCatalogItemAccess, requireCommerceCapacityInquiryAccess, requireCommerceCapacityListingAccess, requireCommerceOfferAccess, requireCommerceProductAccess, requireCommerceVendorForStripe, requireConfiguredServiceCredential, requireConnectedProjectRuntime, requirePlatformRunner, requireProjectAccess, requireProjectRunner, requireSeedApplyAccess, requireSeedPlanAccess, requireSellerTeamAccess, requireServiceBuyerAccess, requireServiceParticipantAccess, requireServiceSellerAccess, requireTeamAccess, requireVendorOrderManager, resolve, resolveAgentArtifactBucket, resolveAgentTaskSignature, resolveApiConfig, resolveAuthApprovalBaseUrl, resolveCloudflareZoneForLaunchPreflight, resolveCommerceCheckoutItem, resolveFulfillmentArtifact, resolveLaunchTemplateRequirements, resolveOrderItemForRefund, resolvePlatformRepositoryDescriptor, resolvePlatformRunnerSecret, resolveProjectDeletionCloudflareZone, resolveProjectLaunchHostBindings, resolvePublicTreeDxTeam, resolveStripeEnvironment, resolveStripePublishableKey, resolveStripeWebhookSecret, resolveManagedCloudflareHostConfigFromConfig, resolveUiProjectionContext, resourceRowsFromLaunch, retryApiLaunchBootstrapFromRequest, rm, runProjectDeletionApiDestroy, runProjectLaunchApiBootstrap, runHostingAudit, runtime, runtimeMarketAuthProvider, runtimeProviders, safeFeedbackClient, safeFeedbackContext, safeFeedbackScreenshot, safePlatformOperationOutput, safePrivateKnowledgeSlug, safeTokenEquals, sanitizeLaunchResultForStorage, sanitizedReturnTo, scheduleBackgroundBootstrap, seedActor, seedCreatesMissingTeams, seedExistingTeamIds, selectDispatchTarget, sendAuthEmail, sendEmailConfirmation, sendTeamInviteEmail, sendWelcomeEmail, serializeFrontmatter, serializeUserEmailAddress, setPrimaryEmailAddress, sharedSdk, shouldBypassAcceptanceAuthEmailDelivery, shouldExposeNonProductionAuthDiagnostics, shouldLogApiRequests, signEditorialPreviewToken, signOperationToken, slugifyContent, slugifyRepositoryContent, sourceFromProjectDetails, store, stripeAccountMissingError, stripeAccountToConnectedAccountPatch, stripeClientSecret, stripeCommerceUrl, stripeConfiguredError, stripeConnectService, stripeMetadataValue, stripePriceTermsDrift, stripeRefundStatus, stripeTimestampToIso, stripeVendorApprovalError, subscriptionClientSecret, subscriptionStatusFromStripe, syncCommerceOfferStripeProduct, syncCommercePriceStripePrice, syncCommerceSubscriptionFromStripe, syncPrimaryEmailCaches, teamInviteAcceptUrlFor, timingSafeEqual, trimmedHeaderValue, uiRuntimeLocals, uniqueCloudflareKvNamespaceReferences, uniqueRelationArray, unknownKeys, unwrapLaunchOperationOutput, unwrapOperationPayload, updateCheckoutCompletionFromGroup, updateLaunchDeployments, validateCiRefForEnvironment, validateFeedbackAccess, validateMarketPassword, validateProjectSlug, validatePublicUsername, validateTeamHostCredentialPayload, verifiedEmailCount, verifyCloudflareDnsWriteForLaunch, verifyGitHubOidcToken, verifyMarketPassword, verifyOperationToken, verifyProviderIdToken, webAuthPayload, webSessionData, writeFile, writeLocalContentRecord, writeParsedLocalContentRecord, yamlLines, yamlScalar } = context;
	const { requireCommonsSteward, commonsErrorResponse } = context;
	app.get('/v1/commons/summary', async (c) => {
					return c.json({ ok: true, payload: await store.commonsSummary(c.get('principal') ?? null) });
				});
	
	app.get('/v1/commons/participants/me', async (c) => {
					const auth = await ensurePrincipal(c);
					if (auth.response) return auth.response;
					try {
						return c.json({ ok: true, payload: await store.ensureCommonsParticipantForPrincipal(auth.principal) });
					} catch (error) {
						return commonsErrorResponse(c, error);
					}
				});
	
	app.get('/v1/commons/participants', async (c) => {
					const steward = await requireCommonsSteward(c);
					if (steward.response) return steward.response;
					return c.json({ ok: true, payload: await store.listCommonsParticipants({
						status: optionalTrimmedString(c.req.query('status')),
						limit: c.req.query('limit'),
					}) });
				});
	
	app.post('/v1/commons/participants/backfill', async (c) => {
					const steward = await requireCommonsSteward(c);
					if (steward.response) return steward.response;
					const users = await store.all(`SELECT * FROM users ORDER BY created_at ASC`);
					const participants = [];
					for (const user of users) {
						participants.push(await store.ensureCommonsParticipantForPrincipal({
							id: user.id,
							displayName: user.display_name,
							email: user.email,
							roles: [],
							permissions: [],
							metadata: parseJsonObject(user.metadata_json, {}),
						}, { metadata: { registrationSource: 'backfill' } }));
					}
					return c.json({ ok: true, payload: { participants, count: participants.length } });
				});
	
	app.get('/v1/commons/questions', async (c) => {
					return c.json({ ok: true, payload: await store.listCommonsQuestions({
						status: optionalTrimmedString(c.req.query('status')),
						limit: c.req.query('limit'),
					}) });
				});
	
	app.post('/v1/commons/questions', async (c) => {
					const auth = await ensurePrincipal(c);
					if (auth.response) return auth.response;
					const body = await c.req.json().catch(() => ({}));
					try {
						return c.json({ ok: true, payload: await store.createCommonsQuestion(auth.principal, {
							title: optionalTrimmedString(body.title),
							body: optionalTrimmedString(body.body),
							metadata: body.metadata && typeof body.metadata === 'object' ? body.metadata : {},
						}) });
					} catch (error) {
						return commonsErrorResponse(c, error);
					}
				});
	
	app.get('/v1/commons/questions/:questionId', async (c) => {
					const question = await store.getCommonsQuestion(c.req.param('questionId'));
					return question ? c.json({ ok: true, payload: question }) : jsonError(c, 404, 'Unknown Commons question.');
				});
	
	app.post('/v1/commons/questions/:questionId/answer', async (c) => {
					const steward = await requireCommonsSteward(c);
					if (steward.response) return steward.response;
					const body = await c.req.json().catch(() => ({}));
					const question = await store.answerCommonsQuestion(c.req.param('questionId'), {
						answer: optionalTrimmedString(body.answer ?? body.message),
						actorType: 'user',
						actorId: steward.principal.id ?? null,
					});
					return question ? c.json({ ok: true, payload: question }) : jsonError(c, 404, 'Unknown Commons question.');
				});
	
	app.post('/v1/commons/questions/:questionId/convert-to-proposal', async (c) => {
					const auth = await ensurePrincipal(c);
					if (auth.response) return auth.response;
					const question = await store.getCommonsQuestion(c.req.param('questionId'));
					if (!question) return jsonError(c, 404, 'Unknown Commons question.');
					if (question.userId !== auth.principal.id && !principalIsSeedAdmin(auth.principal)) return jsonError(c, 403, 'Permission denied.');
					const body = await c.req.json().catch(() => ({}));
					try {
						const proposal = await store.createCommonsProposal(auth.principal, {
							status: 'submitted',
							title: optionalTrimmedString(body.title) ?? question.title,
							summary: optionalTrimmedString(body.summary) ?? question.body.slice(0, 240),
							body: optionalTrimmedString(body.body) ?? question.body,
							scope: optionalTrimmedString(body.scope, 'treeseed_commons'),
							decisionType: optionalTrimmedString(body.decisionType, 'advisory'),
							metadata: { convertedFromQuestionId: question.id },
						});
						await store.run(`UPDATE commons_questions SET status = 'converted_to_proposal', converted_proposal_id = ?, updated_at = ? WHERE id = ?`, [proposal.id, new Date().toISOString(), question.id]);
						await store.recordCommonsGovernanceEvent({
							eventType: 'question.converted_to_proposal',
							actorType: 'user',
							actorId: auth.principal.id,
							participantId: proposal.participantId,
							questionId: question.id,
							proposalId: proposal.id,
							priorState: question.status,
							nextState: 'converted_to_proposal',
						});
						return c.json({ ok: true, payload: proposal });
					} catch (error) {
						return commonsErrorResponse(c, error);
					}
				});
	
	app.get('/v1/commons/proposals', async (c) => {
					return c.json({ ok: true, payload: await store.listCommonsProposals({
						status: optionalTrimmedString(c.req.query('status')),
						scope: optionalTrimmedString(c.req.query('scope')),
						limit: c.req.query('limit'),
					}) });
				});
	
	app.post('/v1/commons/proposals', async (c) => {
					const auth = await ensurePrincipal(c);
					if (auth.response) return auth.response;
					const body = await c.req.json().catch(() => ({}));
					try {
						return c.json({ ok: true, payload: await store.createCommonsProposal(auth.principal, {
							title: optionalTrimmedString(body.title),
							summary: optionalTrimmedString(body.summary),
							body: optionalTrimmedString(body.body),
							scope: optionalTrimmedString(body.scope, 'treeseed_commons'),
							decisionType: optionalTrimmedString(body.decisionType, 'advisory'),
							metadata: body.metadata && typeof body.metadata === 'object' ? body.metadata : {},
						}) });
					} catch (error) {
						return commonsErrorResponse(c, error);
					}
				});
	
	app.get('/v1/commons/proposals/:proposalId', async (c) => {
					const proposal = await store.getCommonsProposal(c.req.param('proposalId'));
					if (!proposal) return jsonError(c, 404, 'Unknown Commons proposal.');
					return c.json({ ok: true, payload: {
						...proposal,
						backings: await store.listCommonsProposalBackings(proposal.id),
						votes: await store.listCommonsProposalVotes(proposal.id),
						events: await store.listCommonsGovernanceEvents({ proposalId: proposal.id, limit: 50 }),
					} });
				});
	
	app.post('/v1/commons/proposals/:proposalId/submit', async (c) => {
					const auth = await ensurePrincipal(c);
					if (auth.response) return auth.response;
					const proposal = await store.getCommonsProposal(c.req.param('proposalId'));
					if (!proposal) return jsonError(c, 404, 'Unknown Commons proposal.');
					if (proposal.userId !== auth.principal.id && !principalIsSeedAdmin(auth.principal)) return jsonError(c, 403, 'Permission denied.');
					return c.json({ ok: true, payload: await store.submitCommonsProposal(proposal.id, { actorType: 'user', actorId: auth.principal.id }) });
				});
	
	app.post('/v1/commons/proposals/:proposalId/back', async (c) => {
					const auth = await ensurePrincipal(c);
					if (auth.response) return auth.response;
					const body = await c.req.json().catch(() => ({}));
					try {
						const proposal = await store.backCommonsProposal(auth.principal, c.req.param('proposalId'), { reason: optionalTrimmedString(body.reason) });
						return proposal ? c.json({ ok: true, payload: proposal }) : jsonError(c, 404, 'Unknown Commons proposal.');
					} catch (error) {
						return commonsErrorResponse(c, error);
					}
				});
	
	app.post('/v1/commons/proposals/:proposalId/vote', async (c) => {
					const auth = await ensurePrincipal(c);
					if (auth.response) return auth.response;
					const body = await c.req.json().catch(() => ({}));
					try {
						const proposal = await store.voteCommonsProposal(auth.principal, c.req.param('proposalId'), {
							vote: optionalTrimmedString(body.vote),
							reason: optionalTrimmedString(body.reason),
						});
						return proposal ? c.json({ ok: true, payload: proposal }) : jsonError(c, 404, 'Unknown Commons proposal.');
					} catch (error) {
						return commonsErrorResponse(c, error);
					}
				});
}
