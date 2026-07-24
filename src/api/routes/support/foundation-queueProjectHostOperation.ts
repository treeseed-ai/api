export function installFoundationQueueProjectHostOperationRoutes(context: any) {
	const { AGENT_PROMOTION_APPROVAL_DECISIONS, AGENT_TASK_SIGNATURES, AUTH_PROVIDERS, AgentSdk, CHECKOUT_COMMERCIAL_OFFER_MODES, CHECKOUT_OFFER_MODES, CHECKOUT_SUBSCRIPTION_OFFER_MODES, DatabaseAuthProvider, FEEDBACK_SCREENSHOT_TYPES, FEEDBACK_TYPES, GITHUB_ACTIONS_OIDC_ISSUER, HOST_KIND_SESSION_KEYS, LOCAL_CONTENT_COLLECTIONS, LOCAL_CONTENT_DEFAULTS, LOCAL_DECISION_TYPE_VALUES, LOCAL_WORK_CONTENT_COLLECTIONS, MARKET_EMAIL_CONFIRMATION_PREFIX, MAX_FEEDBACK_MESSAGE_LENGTH, MAX_FEEDBACK_SCREENSHOT_BYTES, MarketControlPlaneStore, NOTIFICATION_CONTENT_CAPABILITIES, PERSONAL_THEME_COMPILER_VERSION, PLAINTEXT_HOST_CREDENTIAL_FIELD_NAMES, PLATFORM_OPERATION_SCOPES, POSTGRES_AUTH_PROVIDER_ID, PROPOSAL_VERDICT_DECISION_TYPES, RemoteClient, RemoteOperationsClient, RemoteSdkClient, SENSITIVE_QUERY_PARAM_PATTERN, STRIPE_PRICE_MIRROR_OFFER_MODES, STRIPE_PRODUCT_MIRROR_OFFER_MODES, OperationsSdk, accountDeletionBlockers, accountDeletionConfirmationMatches, addRelationValue, apiDatabaseUrl, app, appendLaunchDeploymentEvent, appendLaunchPhaseProjection, appendProjectDeletionProgress, applyCommerceRefundState, applyContentPublishResult, applyHubLaunchFailure, applyHubLaunchResult, applySeedWithStore, artifactDownloadPayload, authConfig, authEmailDeliveryFailureDetail, authEmailDeliveryFailureReason, authProviderId, authTokenTimestampMillis, authTokenTimestampSeconds, availabilityAttempts, availabilityRateLimit, backfillUserEmailAddresses, base64Url, base64urlJson, bearerTokenFromRequest, buildCommerceCheckoutMetadata, buildCommerceStripeMetadata, buildGovernanceApprovalProjection, buildGovernanceProjection, buildInfrastructureProjection, buildKnowledgeArtifactProjection, buildKnowledgeProjection, buildLaunchCredentialOverlay, buildWorkdayProjection, canSkipCloudflareCleanupAfterFailedLaunch, canonicalArchitectureTopology, capacity, centralMarketProfile, checkoutGroupKey, checkoutGroupKind, checkoutGroupStatus, ciOperationForAction, cleanFeedbackString, cloudflareDeletionAuthenticationMessage, cloudflareDnsDomainsForHostValidation, cloudflareErrorMessage, cloudflareProjectDeletionResourceNames, cloudflareRequestForLaunchPreflight, cloudflareRequestForProjectDeletion, collectHostingAuditCredentialOverlay, commerceCheckoutError, commerceErrorResponse, commerceStripeLookupKey, commerceStripePriceParams, commerceStripeProductParams, commerceStripeSyncContext, config, configuredAuthProviderId, confirmationUrlFor, consumeReauthentication, contentRelationPolicy, createApiExtension, createCapacityControlPlane, createCipheriv, createClientEncryptedEscrowService, createCommerceCheckoutRun, createCommerceCheckoutRunForServiceContract, createDecipheriv, createDecisionFromProposals, createGitHubActionsSecretEnclave, createGitHubAppAdapter, createHash, createHmac, createMarketEmailConfirmation, createMarketPostgresDatabase, createMarketWebSession, createOrResendUserEmailAddress, createProjectHostCredentialSessions, createProjectInternalClient, createPublicKey, createRelatedLocalContentRecord, createStripeConnectService, createTreeDxCredentialBridge, createVerify, credentialSessionKey, credentialSessionSecret, db, decodeRouteParam, decorateJob, decoratePlatformOperation, decryptCredentialSessionPayload, decryptHostConfig, decryptTeamHostForLaunch, decryptedHostConfigSummary, defaultConfig, deleteCloudflareDnsRecordsForProject, deleteCloudflareProjectResources, deleteTeamCapacityAggregate, derivePlatformOperationNavigation, deriveProjectHostBindingsView, domainInZone, encryptCredentialSessionPayload, encryptedHostPayloadLooksValid, enqueueTreeDxProvisionOperation, ensureCommerceStripeCustomer, ensureMarketCredentialSchema, ensurePrincipal, entitlementRenewalStateFromSubscription, enumValue, exchangeProviderIdentity, executeInline, executeProjectApi, executeSdkOperation, existsSync, exportSeedWithStore, exposeAuthTokenForTests, fallbackRemoteCapability, findById, findDispatchCapability, getSiteAuthConfig, getUserEmailAddress, githubOidcJwksCache, githubRequestForProjectDeletion, grantCommerceEntitlementsForOrder, handleCommerceInvoiceWebhook, handleCommercePaymentIntentWebhook, handleCommerceSubscriptionWebhook, hasRecordedCloudflareRuntimeResources, hashMarketPassword, hostBindingRequiresUnlock, hostKindForBinding, hubRepositoryPolicies, inferZoneNameForDomain, installApiRequestLogger, installCapacityRoutes, installProjectDeploymentRoutes, isLocalAcceptanceServicePrincipal, isLoopbackUrl, isPlatformOperationTerminal, isTeamApiPrincipal, isValidPersonalThemeDraft, jsonError, jsonThrownError, launchCapabilityPreset, launchPlannerRepositoryTopology, listCloudflareNamedResources, listManagedHostsFromConfig, listUserEmailAddresses, loadGitHubOidcJwks, loadInfrastructureSeedState, loadKnowledgeContentEntries, loadNotificationPreferences, loadProjectHostBindingContext, loadTemplateCatalog, localAcceptanceAdminToken, localAcceptanceAuthEnabled, localContentPath, localContentRoot, logRequests, managedCloudflareConfigMissing, markdownToPlainProjectSummary, marketAuthContext, marketEmailTokenHash, marketProfilesForTeams, mergeCapability, mergeStringConfig, mkdir, nonSecretLaunchJobInput, normalizeAppearancePreference, normalizeAuditHostKinds, normalizeBaseUrl, normalizeCheckoutQuantity, normalizeCiEnvironment, normalizeDomainName, normalizeEmail, normalizeLocalContentInput, normalizeMarketProfile, normalizeNotificationPreferences, normalizeProjectDomainInput, normalizeProjectLaunchHostBindings, normalizeProviderCredentialConfig, normalizeRelationArray, normalizeRepositoryContentInput, normalizeRepositoryRelationArray, normalizeRepositorySlug, normalizeSeedEnvironments, normalizeTemplateLaunchRequirements, normalizeTemplateId, normalizeUsername, normalizedCloudflareKvNamespaceReference, operationTokenSecret, optionalTrimmedString, orderStatusFromPaymentGroup, parseBase64urlJson, parseBooleanEnvValue, parseJsonObject, parseYaml, passwordResetUrlFor, patchLaunchIntentForCredentialOverlay, paymentGroupStatusFromPaymentIntent, pbkdf2Sync, persistProjectHostBindingOperationMetadata, personalThemeFromRow, plaintextHostCredentialFieldPaths, planKnowledgeHubLaunch, planProjectHostBindingOperation, planSeedWithStore, platformOperationMutationError, principalCanManageCommerceProduct, principalHasGlobalPlatformRole, principalHasPermission, principalIsSeedAdmin, privateKnowledgeAuditPayload, processCommerceStripeWebhook, projectAllowedCiRepositories, projectApiConnection, projectAppHref, projectDeletionBlockerRows, projectDeletionConfirmationMatches, projectDeletionHostname, projectDeletionOperation, projectHostBindingMetadata, projectHostResponsePayload, providerConfigFor, providerCredentialValuesForAudit, providerJwksCache, publicPaymentGroups, randomBytes, randomUUID, readCapacityRequestObject, readFile, readJsonOrFormBody, readLocalContentRecord, recordContentNotificationEvent, recordFeedbackSubmission, recordPrivateKnowledgeAudit, redactCommerceOwnershipWorkflow, redactCommerceServiceRequestForBuyer, redactedRequestTarget, refreshCommercePaymentGroupState, refreshCommerceStripeAccount, rejectPlaintextHostCredentialFields, rejectProjectSecretUnlockMaterial, relative, remainingRefundableAmount, repositoryContentRelationPolicy, repositoryInventoryWithPlatform, requestClientIp, requestSessionMetadata, requireCatalogItemAccess, requireCommerceCapacityInquiryAccess, requireCommerceCapacityListingAccess, requireCommerceOfferAccess, requireCommerceProductAccess, requireCommerceVendorForStripe, requireConfiguredServiceCredential, requireConnectedProjectRuntime, requirePlatformRunner, requireProjectAccess, requireProjectRunner, requireSeedApplyAccess, requireSeedPlanAccess, requireSellerTeamAccess, requireServiceBuyerAccess, requireServiceParticipantAccess, requireServiceSellerAccess, requireTeamAccess, requireVendorOrderManager, resolve, resolveAgentArtifactBucket, resolveAgentTaskSignature, resolveApiConfig, resolveAuthApprovalBaseUrl, resolveCloudflareZoneForLaunchPreflight, resolveCommerceCheckoutItem, resolveFulfillmentArtifact, resolveLaunchTemplateRequirements, resolveOrderItemForRefund, resolvePlatformRepositoryDescriptor, resolvePlatformRunnerSecret, resolveProjectDeletionCloudflareZone, resolveProjectLaunchHostBindings, resolvePublicTreeDxTeam, resolveStripeEnvironment, resolveStripePublishableKey, resolveStripeWebhookSecret, resolveManagedCloudflareHostConfigFromConfig, resolveUiProjectionContext, resourceRowsFromLaunch, retryApiLaunchBootstrapFromRequest, rm, runProjectDeletionApiDestroy, runProjectLaunchApiBootstrap, runHostingAudit, runtime, runtimeMarketAuthProvider, runtimeProviders, safeFeedbackClient, safeFeedbackContext, safeFeedbackScreenshot, safePlatformOperationOutput, safePrivateKnowledgeSlug, safeTokenEquals, sanitizeLaunchResultForStorage, sanitizedReturnTo, scheduleBackgroundBootstrap, seedActor, seedCreatesMissingTeams, seedExistingTeamIds, selectDispatchTarget, sendAuthEmail, sendEmailConfirmation, sendTeamInviteEmail, sendWelcomeEmail, serializeFrontmatter, serializeUserEmailAddress, setPrimaryEmailAddress, sharedSdk, shouldBypassAcceptanceAuthEmailDelivery, shouldExposeNonProductionAuthDiagnostics, shouldLogApiRequests, signEditorialPreviewToken, signOperationToken, slugifyContent, slugifyRepositoryContent, sourceFromProjectDetails, store, stripeAccountMissingError, stripeAccountToConnectedAccountPatch, stripeClientSecret, stripeCommerceUrl, stripeConfiguredError, stripeConnectService, stripeMetadataValue, stripePriceTermsDrift, stripeRefundStatus, stripeTimestampToIso, stripeVendorApprovalError, subscriptionClientSecret, subscriptionStatusFromStripe, syncCommerceOfferStripeProduct, syncCommercePriceStripePrice, syncCommerceSubscriptionFromStripe, syncPrimaryEmailCaches, teamInviteAcceptUrlFor, timingSafeEqual, trimmedHeaderValue, uiRuntimeLocals, uniqueCloudflareKvNamespaceReferences, uniqueRelationArray, unknownKeys, unwrapLaunchOperationOutput, unwrapOperationPayload, updateCheckoutCompletionFromGroup, updateLaunchDeployments, validateCiRefForEnvironment, validateFeedbackAccess, validateMarketPassword, validateProjectSlug, validatePublicUsername, validateTeamHostCredentialPayload, verifiedEmailCount, verifyCloudflareDnsWriteForLaunch, verifyGitHubOidcToken, verifyMarketPassword, verifyOperationToken, verifyProviderIdToken, webAuthPayload, webSessionData, writeFile, writeLocalContentRecord, writeParsedLocalContentRecord, yamlLines, yamlScalar } = context;
	const queueProjectHostOperation = async (c, kind) => {
					const access = await requireProjectAccess(c, store, c.req.param('projectId'), kind === 'audit' ? 'projects:read:team' : 'projects:manage:team');
					if (access.response) return access.response;
					const body = await c.req.json().catch(() => ({}));
					const rejectedUnlock = rejectProjectSecretUnlockMaterial(
						c,
						body,
						'Project host operations no longer accept passphrases or credential sessions. Re-enter or migrate team-owned host secrets through CLI/Admin client-side flows before retrying.',
					);
					if (rejectedUnlock) return rejectedUnlock;
					const requirementKey = optionalTrimmedString(c.req.param('requirementKey')) ?? optionalTrimmedString(body.requirementKey);
					const context = await loadProjectHostBindingContext({
						store,
						runtime,
						principal: access.principal,
						details: access.details,
					});
					let replacementHostBindings = {};
					if (kind === 'replace') {
						const replacementInput = body.hostBindings && typeof body.hostBindings === 'object'
							? { hostBindings: body.hostBindings }
							: body.hostBinding && typeof body.hostBinding === 'object' && requirementKey
								? { hostBindings: { [requirementKey]: body.hostBinding } }
								: body.binding && typeof body.binding === 'object' && requirementKey
									? { hostBindings: { [requirementKey]: body.binding } }
									: {};
						try {
							replacementHostBindings = normalizeProjectLaunchHostBindings(replacementInput);
						} catch (error) {
							return jsonError(c, 400, error instanceof Error ? error.message : String(error), { code: 'invalid_host_binding_replacement' });
						}
						if (requirementKey && !replacementHostBindings[requirementKey]) {
							return jsonError(c, 400, `Replacement binding for ${requirementKey} is required.`, { code: 'missing_host_binding_replacement' });
						}
					}
					let plan;
					try {
						plan = planProjectHostBindingOperation({
							kind,
							requirementKey,
							currentHostBindings: context.currentHostBindings,
							replacementHostBindings,
							launchRequirements: context.launchRequirements,
							repositoryHosts: context.repositoryHosts,
							teamHosts: context.teamHosts,
							managedHosts: context.managedHosts,
							defaultHosts: context.defaultHosts,
							projectSlug: context.project.slug,
							projectName: context.project.name,
						});
					} catch (error) {
						return jsonError(c, 400, error instanceof Error ? error.message : String(error), { code: 'invalid_host_binding_operation' });
					}
					if (plan.audit.summary.status === 'blocked') {
						return jsonError(c, 400, 'Project host operation is blocked by invalid host bindings.', {
							code: 'host_binding_operation_blocked',
							audit: plan.audit,
						});
					}
					const scopedRequirementKeys = requirementKey ? [requirementKey] : plan.operationSummary.changedRequirementKeys;
					const requiresUnlock = Object.entries(plan.nextHostBindings)
						.some(([key, binding]) => (scopedRequirementKeys.length === 0 || scopedRequirementKeys.includes(key)) && hostBindingRequiresUnlock(binding));
					if ((kind === 'rotate' || kind === 'replace' || kind === 'resync') && requiresUnlock) {
						return jsonError(c, 400, 'Project host operations cannot unlock team-owned secrets in the API. Re-enter or migrate the selected host secrets through CLI/Admin client-side flows before retrying.', {
							code: 'sensitive_passphrase_rejected',
						});
					}
					const credentialSessions = {};
					const repository = resolvePlatformRepositoryDescriptor(runtime.resolved.config, access.details, {
						repository: {
							role: 'software',
							writeMode: 'branch',
							branchName: `treeseed/hosts-${kind}-${Date.now()}`,
							push: true,
							pathPolicies: [
								{ allow: 'treeseed.site.yaml' },
								{ allow: 'src/env.yaml' },
								{ allow: 'src/manifest.yaml' },
								{ allow: 'package.json' },
							],
						},
					});
					const operation = await store.createPlatformOperation({
						namespace: 'project_hosts',
						operation: `host_binding_${kind}`,
						target: 'market_operations_runner',
						idempotencyKey: optionalTrimmedString(body.idempotencyKey),
						requestedByType: isTeamApiPrincipal(access.principal) ? 'team_api_key' : c.get('actorType') === 'service' ? 'service' : 'user',
						requestedById: access.principal.id,
						input: {
							projectId: context.project.id,
							teamId: context.project.teamId,
							kind,
							requirementKey: requirementKey ?? null,
							repository,
							hostBindings: plan.nextHostBindings,
							previousHostBindings: plan.previousHostBindings,
							hostBindingPlans: plan.hostBindingPlans,
							operationSummary: plan.operationSummary,
							audit: plan.audit,
							credentialSessions,
							approvalRequired: true,
							approvalSatisfied: true,
							approvalId: `project-hosts:${context.project.id}:${kind}:${Date.now()}`,
							commitMessage: `Update ${context.project.name} project host bindings`,
						},
					});
					await store.appendPlatformOperationEvent(operation.id, `project_hosts.${kind}_queued`, {
						projectId: context.project.id,
						requirementKey: requirementKey ?? null,
						changedRequirementKeys: plan.operationSummary.changedRequirementKeys,
						requiresRepositoryConfigWrite: plan.operationSummary.requiresRepositoryConfigWrite,
						requiresSecretSync: plan.operationSummary.requiresSecretSync,
					}).catch(() => {});
					await persistProjectHostBindingOperationMetadata({
						store,
						details: access.details,
						nextHostBindings: kind === 'replace' ? context.currentHostBindings : plan.nextHostBindings,
						hostBindingPlans: kind === 'replace' ? context.hostBindingPlans : plan.hostBindingPlans,
						audit: plan.audit,
						operation,
						kind,
						requirementKey,
					});
					const refreshed = await loadProjectHostBindingContext({
						store,
						runtime,
						principal: access.principal,
						details: await store.getProjectDetails(context.project.id),
					});
					return c.json({
						ok: true,
						payload: projectHostResponsePayload(refreshed, { plan }),
						operation: decoratePlatformOperation(runtime.resolved.config.baseUrl, operation),
					}, { status: 202 });
				};
	context.queueProjectHostOperation = queueProjectHostOperation;
}
