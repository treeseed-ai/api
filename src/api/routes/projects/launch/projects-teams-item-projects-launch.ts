import { completeProjectLaunch, prepareProjectLaunch } from './project-launch-phases.ts';

export function installProjectsTeamsItemProjectsLaunchRoutes(context: any) {
	const { AGENT_PROMOTION_APPROVAL_DECISIONS, AGENT_TASK_SIGNATURES, AUTH_PROVIDERS, AgentSdk, CHECKOUT_COMMERCIAL_OFFER_MODES, CHECKOUT_OFFER_MODES, CHECKOUT_SUBSCRIPTION_OFFER_MODES, DatabaseAuthProvider, FEEDBACK_SCREENSHOT_TYPES, FEEDBACK_TYPES, GITHUB_ACTIONS_OIDC_ISSUER, HOST_KIND_SESSION_KEYS, LOCAL_CONTENT_COLLECTIONS, LOCAL_CONTENT_DEFAULTS, LOCAL_DECISION_TYPE_VALUES, LOCAL_WORK_CONTENT_COLLECTIONS, MARKET_EMAIL_CONFIRMATION_PREFIX, MAX_FEEDBACK_MESSAGE_LENGTH, MAX_FEEDBACK_SCREENSHOT_BYTES, MarketControlPlaneStore, NOTIFICATION_CONTENT_CAPABILITIES, PERSONAL_THEME_COMPILER_VERSION, PLAINTEXT_HOST_CREDENTIAL_FIELD_NAMES, PLATFORM_OPERATION_SCOPES, POSTGRES_AUTH_PROVIDER_ID, PROPOSAL_VERDICT_DECISION_TYPES, RemoteClient, RemoteOperationsClient, RemoteSdkClient, SENSITIVE_QUERY_PARAM_PATTERN, STRIPE_PRICE_MIRROR_OFFER_MODES, STRIPE_PRODUCT_MIRROR_OFFER_MODES, OperationsSdk, accountDeletionBlockers, accountDeletionConfirmationMatches, addRelationValue, apiDatabaseUrl, app, appendLaunchDeploymentEvent, appendLaunchPhaseProjection, appendProjectDeletionProgress, applyCommerceRefundState, applyContentPublishResult, applyHubLaunchFailure, applyHubLaunchResult, applySeedWithStore, artifactDownloadPayload, authConfig, authEmailDeliveryFailureDetail, authEmailDeliveryFailureReason, authProviderId, authTokenTimestampMillis, authTokenTimestampSeconds, availabilityAttempts, availabilityRateLimit, backfillUserEmailAddresses, base64Url, base64urlJson, bearerTokenFromRequest, buildCommerceCheckoutMetadata, buildCommerceStripeMetadata, buildGovernanceApprovalProjection, buildGovernanceProjection, buildInfrastructureProjection, buildKnowledgeArtifactProjection, buildKnowledgeProjection, buildLaunchCredentialOverlay, buildWorkdayProjection, canSkipCloudflareCleanupAfterFailedLaunch, canonicalArchitectureTopology, capacity, centralMarketProfile, checkoutGroupKey, checkoutGroupKind, checkoutGroupStatus, ciOperationForAction, cleanFeedbackString, cloudflareDeletionAuthenticationMessage, cloudflareDnsDomainsForHostValidation, cloudflareErrorMessage, cloudflareProjectDeletionResourceNames, cloudflareRequestForLaunchPreflight, cloudflareRequestForProjectDeletion, collectHostingAuditCredentialOverlay, commerceCheckoutError, commerceErrorResponse, commerceStripeLookupKey, commerceStripePriceParams, commerceStripeProductParams, commerceStripeSyncContext, config, configuredAuthProviderId, confirmationUrlFor, consumeReauthentication, contentRelationPolicy, createApiExtension, createCapacityControlPlane, createCipheriv, createClientEncryptedEscrowService, createCommerceCheckoutRun, createCommerceCheckoutRunForServiceContract, createDecipheriv, createDecisionFromProposals, createGitHubActionsSecretEnclave, createGitHubAppAdapter, createHash, createHmac, createMarketEmailConfirmation, createMarketPostgresDatabase, createMarketWebSession, createOrResendUserEmailAddress, createProjectHostCredentialSessions, createProjectInternalClient, createPublicKey, createRelatedLocalContentRecord, createStripeConnectService, createTreeDxCredentialBridge, createVerify, credentialSessionKey, credentialSessionSecret, db, decodeRouteParam, decorateJob, decoratePlatformOperation, decryptCredentialSessionPayload, decryptHostConfig, decryptTeamHostForLaunch, decryptedHostConfigSummary, defaultConfig, deleteCloudflareDnsRecordsForProject, deleteCloudflareProjectResources, deleteTeamCapacityAggregate, derivePlatformOperationNavigation, deriveProjectHostBindingsView, domainInZone, encryptCredentialSessionPayload, encryptedHostPayloadLooksValid, enqueueTreeDxProvisionOperation, ensureCommerceStripeCustomer, ensureMarketCredentialSchema, ensurePrincipal, entitlementRenewalStateFromSubscription, enumValue, exchangeProviderIdentity, executeInline, executeProjectApi, executeSdkOperation, existsSync, exportSeedWithStore, exposeAuthTokenForTests, fallbackRemoteCapability, findById, findDispatchCapability, getSiteAuthConfig, getUserEmailAddress, githubOidcJwksCache, githubRequestForProjectDeletion, grantCommerceEntitlementsForOrder, handleCommerceInvoiceWebhook, handleCommercePaymentIntentWebhook, handleCommerceSubscriptionWebhook, hasRecordedCloudflareRuntimeResources, hashMarketPassword, hostBindingRequiresUnlock, hostKindForBinding, hubRepositoryPolicies, inferZoneNameForDomain, installApiRequestLogger, installCapacityRoutes, installProjectDeploymentRoutes, isLocalAcceptanceServicePrincipal, isLoopbackUrl, isPlatformOperationTerminal, isTeamApiPrincipal, isValidPersonalThemeDraft, jsonError, jsonThrownError, launchCapabilityPreset, launchPlannerRepositoryTopology, listCloudflareNamedResources, listManagedHostsFromConfig, listUserEmailAddresses, loadGitHubOidcJwks, loadInfrastructureSeedState, loadKnowledgeContentEntries, loadNotificationPreferences, loadProjectHostBindingContext, loadTemplateCatalog, localAcceptanceAdminToken, localAcceptanceAuthEnabled, localContentPath, localContentRoot, logRequests, managedCloudflareConfigMissing, markdownToPlainProjectSummary, marketAuthContext, marketEmailTokenHash, marketProfilesForTeams, mergeCapability, mergeStringConfig, mkdir, nonSecretLaunchJobInput, normalizeAppearancePreference, normalizeAuditHostKinds, normalizeBaseUrl, normalizeCheckoutQuantity, normalizeCiEnvironment, normalizeDomainName, normalizeEmail, normalizeLocalContentInput, normalizeMarketProfile, normalizeNotificationPreferences, normalizeProjectDomainInput, normalizeProjectLaunchHostBindings, normalizeProviderCredentialConfig, normalizeRelationArray, normalizeRepositoryContentInput, normalizeRepositoryRelationArray, normalizeRepositorySlug, normalizeSeedEnvironments, normalizeTemplateLaunchRequirements, normalizeTemplateId, normalizeUsername, normalizedCloudflareKvNamespaceReference, operationTokenSecret, optionalTrimmedString, orderStatusFromPaymentGroup, parseBase64urlJson, parseBooleanEnvValue, parseJsonObject, parseYaml, passwordResetUrlFor, patchLaunchIntentForCredentialOverlay, paymentGroupStatusFromPaymentIntent, pbkdf2Sync, persistProjectHostBindingOperationMetadata, personalThemeFromRow, plaintextHostCredentialFieldPaths, planKnowledgeHubLaunch, planProjectHostBindingOperation, planSeedWithStore, platformOperationMutationError, principalCanManageCommerceProduct, principalHasGlobalPlatformRole, principalHasPermission, principalIsSeedAdmin, privateKnowledgeAuditPayload, processCommerceStripeWebhook, projectAllowedCiRepositories, projectApiConnection, projectAppHref, projectDeletionBlockerRows, projectDeletionConfirmationMatches, projectDeletionHostname, projectDeletionOperation, projectHostBindingMetadata, projectHostResponsePayload, providerConfigFor, providerCredentialValuesForAudit, providerJwksCache, publicPaymentGroups, randomBytes, randomUUID, readCapacityRequestObject, readFile, readJsonOrFormBody, readLocalContentRecord, recordContentNotificationEvent, recordFeedbackSubmission, recordPrivateKnowledgeAudit, redactCommerceOwnershipWorkflow, redactCommerceServiceRequestForBuyer, redactedRequestTarget, refreshCommercePaymentGroupState, refreshCommerceStripeAccount, rejectPlaintextHostCredentialFields, rejectProjectSecretUnlockMaterial, relative, remainingRefundableAmount, repositoryContentRelationPolicy, repositoryInventoryWithPlatform, requestClientIp, requestSessionMetadata, requireCatalogItemAccess, requireCommerceCapacityInquiryAccess, requireCommerceCapacityListingAccess, requireCommerceOfferAccess, requireCommerceProductAccess, requireCommerceVendorForStripe, requireConfiguredServiceCredential, requireConnectedProjectRuntime, requirePlatformRunner, requireProjectAccess, requireProjectRunner, requireSeedApplyAccess, requireSeedPlanAccess, requireSellerTeamAccess, requireServiceBuyerAccess, requireServiceParticipantAccess, requireServiceSellerAccess, requireTeamAccess, requireVendorOrderManager, resolve, resolveAgentArtifactBucket, resolveAgentTaskSignature, resolveApiConfig, resolveAuthApprovalBaseUrl, resolveCloudflareZoneForLaunchPreflight, resolveCommerceCheckoutItem, resolveFulfillmentArtifact, resolveLaunchTemplateRequirements, resolveOrderItemForRefund, resolvePlatformRepositoryDescriptor, resolvePlatformRunnerSecret, resolveProjectDeletionCloudflareZone, resolveProjectLaunchHostBindings, resolvePublicTreeDxTeam, resolveStripeEnvironment, resolveStripePublishableKey, resolveStripeWebhookSecret, resolveManagedCloudflareHostConfigFromConfig, resolveUiProjectionContext, resourceRowsFromLaunch, retryApiLaunchBootstrapFromRequest, rm, runProjectDeletionApiDestroy, runProjectLaunchApiBootstrap, runHostingAudit, runtime, runtimeMarketAuthProvider, runtimeProviders, safeFeedbackClient, safeFeedbackContext, safeFeedbackScreenshot, safePlatformOperationOutput, safePrivateKnowledgeSlug, safeTokenEquals, sanitizeLaunchResultForStorage, sanitizedReturnTo, scheduleBackgroundBootstrap, seedActor, seedCreatesMissingTeams, seedExistingTeamIds, selectDispatchTarget, sendAuthEmail, sendEmailConfirmation, sendTeamInviteEmail, sendWelcomeEmail, serializeFrontmatter, serializeUserEmailAddress, setPrimaryEmailAddress, sharedSdk, shouldBypassAcceptanceAuthEmailDelivery, shouldExposeNonProductionAuthDiagnostics, shouldLogApiRequests, signEditorialPreviewToken, signOperationToken, slugifyContent, slugifyRepositoryContent, sourceFromProjectDetails, store, stripeAccountMissingError, stripeAccountToConnectedAccountPatch, stripeClientSecret, stripeCommerceUrl, stripeConfiguredError, stripeConnectService, stripeMetadataValue, stripePriceTermsDrift, stripeRefundStatus, stripeTimestampToIso, stripeVendorApprovalError, subscriptionClientSecret, subscriptionStatusFromStripe, syncCommerceOfferStripeProduct, syncCommercePriceStripePrice, syncCommerceSubscriptionFromStripe, syncPrimaryEmailCaches, teamInviteAcceptUrlFor, timingSafeEqual, trimmedHeaderValue, uiRuntimeLocals, uniqueCloudflareKvNamespaceReferences, uniqueRelationArray, unknownKeys, unwrapLaunchOperationOutput, unwrapOperationPayload, updateCheckoutCompletionFromGroup, updateLaunchDeployments, validateCiRefForEnvironment, validateFeedbackAccess, validateMarketPassword, validateProjectSlug, validatePublicUsername, validateTeamHostCredentialPayload, verifiedEmailCount, verifyCloudflareDnsWriteForLaunch, verifyGitHubOidcToken, verifyMarketPassword, verifyOperationToken, verifyProviderIdToken, webAuthPayload, webSessionData, writeFile, writeLocalContentRecord, writeParsedLocalContentRecord, yamlLines, yamlScalar } = context;
	app.post('/v1/teams/:teamId/projects/launch', async (c) => {
					const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'projects:manage:team');
					if (access.response) return access.response;
					const body = await c.req.json().catch(() => ({}));
					const rejectedUnlock = rejectProjectSecretUnlockMaterial(
						c,
						body,
						'Project launch no longer accepts passphrases or provider credential sessions. Re-enter or migrate team-owned secrets into approved targets before launch.',
					);
					if (rejectedUnlock) return rejectedUnlock;
					let normalizedHostBindings;
					try {
						normalizedHostBindings = normalizeProjectLaunchHostBindings(body);
					} catch (error) {
						return jsonError(c, 400, error instanceof Error ? error.message : String(error), { code: 'invalid_host_bindings' });
					}
					const canonicalIntent = body.intent && typeof body.intent === 'object' ? body.intent : null;
					const requestedHub = canonicalIntent?.hub && typeof canonicalIntent.hub === 'object' ? canonicalIntent.hub : null;
					const requestedTeam = canonicalIntent?.team && typeof canonicalIntent.team === 'object' ? canonicalIntent.team : null;
					const requestedSource = canonicalIntent?.source && typeof canonicalIntent.source === 'object' ? canonicalIntent.source : null;
					const requestedRepository = canonicalIntent?.repository && typeof canonicalIntent.repository === 'object' ? canonicalIntent.repository : null;
					const requestedHosting = canonicalIntent?.hosting && typeof canonicalIntent.hosting === 'object' ? canonicalIntent.hosting : null;
					const requestedSlug = typeof requestedHub?.slug === 'string' ? requestedHub.slug : body.slug;
					const requestedName = typeof requestedHub?.name === 'string' ? requestedHub.name : body.name;
					const requestedCoreObjective = typeof requestedHub?.coreObjective === 'string'
						? requestedHub.coreObjective
						: typeof body.coreObjective === 'string'
							? body.coreObjective
							: typeof body.summary === 'string'
								? body.summary
								: typeof body.description === 'string'
									? body.description
									: null;
					const requestedPurpose = typeof requestedHub?.purpose === 'string'
						? requestedHub.purpose
						: markdownToPlainProjectSummary(requestedCoreObjective, null);
					if (!requestedSlug || !requestedName) {
						return jsonError(c, 400, 'slug and name are required.');
					}
					const teamId = c.req.param('teamId');
					if (requestedTeam?.id && requestedTeam.id !== teamId) {
						return jsonError(c, 400, 'Launch intent team.id must match the route team.');
					}
					const hostingMode = typeof body.hostingMode === 'string'
						? body.hostingMode
						: requestedHosting?.mode === 'treeseed_managed'
							? 'managed'
							: typeof requestedHosting?.mode === 'string'
								? requestedHosting.mode
								: 'managed';
					const hostingKind = hostingMode === 'managed' ? 'hosted_project' : 'self_hosted_project';
					const registration = hostingMode === 'hybrid' ? 'optional' : 'none';
					const sourceKind = typeof body.sourceKind === 'string' ? body.sourceKind : typeof requestedSource?.kind === 'string' ? requestedSource.kind : 'blank';
					const rawSourceRef = typeof body.sourceRef === 'string'
						? body.sourceRef
						: typeof requestedSource?.ref === 'string'
							? requestedSource.ref
							: null;
					const sourceRef = rawSourceRef ? normalizeTemplateId(rawSourceRef) : null;
					const sourceVersion = typeof requestedSource?.version === 'string' ? requestedSource.version : typeof body.sourceVersion === 'string' ? body.sourceVersion : null;
					const repoProvider = typeof body.repoProvider === 'string' ? body.repoProvider : typeof requestedRepository?.provider === 'string' ? requestedRepository.provider : 'github';
					const repoVisibility = typeof body.repoVisibility === 'string' ? body.repoVisibility : typeof requestedRepository?.visibility === 'string' ? requestedRepository.visibility : 'private';
					if (!['blank', 'blank_hub', 'template', 'knowledge_pack', 'market_listing'].includes(sourceKind)) {
						return jsonError(c, 400, `Unsupported sourceKind "${sourceKind}".`);
					}
					if ((sourceKind === 'template' || sourceKind === 'market_listing') && !sourceRef) {
						return jsonError(c, 400, 'Project launch requires a selected template.', { code: 'missing_template' });
					}
					if (repoProvider !== 'github') {
						return jsonError(c, 400, 'Knowledge Hub launch currently supports GitHub repositories only.');
					}
					let launchRepositoryTopology;
					try {
						launchRepositoryTopology = launchPlannerRepositoryTopology(requestedRepository?.topology);
					} catch (error) {
						return jsonError(c, 400, error instanceof Error ? error.message : String(error), {
							code: error?.code ?? 'invalid_project_architecture',
						});
					}
					if (hostingMode !== 'managed') {
						return jsonError(c, 400, 'Live project launch currently supports managed hosting only. Use treeseed config --connect-market for hybrid pairing.');
					}
						const team = await store.getTeam(teamId);
						const removedRuntimeHostFields = [
							['process', 'ingHostMode'].join(''),
							['process', 'ingHostId'].join(''),
							['process', 'ingHostConfig'].join(''),
						];
						const removedRuntimeSessionKey = ['process', 'ingHost'].join('');
						if (removedRuntimeHostFields.some((field) => body[field] !== undefined) || body.credentialSessions?.[removedRuntimeSessionKey] !== undefined) {
							return jsonError(c, 400, 'Project launch no longer accepts runtime host configuration. Create and deploy a capacity provider from the capacity provider lifecycle pages.');
						}
						let templateLaunchRequirements;
						try {
							templateLaunchRequirements = await resolveLaunchTemplateRequirements({
								store,
								principal: c.get('principal'),
								config: runtime.resolved.config,
								sourceKind,
								sourceRef,
								requireKnownTemplate: true,
							});
						} catch (error) {
							return jsonError(c, 400, error instanceof Error ? error.message : String(error), { code: 'unknown_template' });
						}
						const [managedHostInventory, teamWebHosts, repositoryHostRows] = await Promise.all([
							listManagedHostsFromConfig(teamId, runtime).catch(() => []),
							store.listTeamWebHosts(teamId).catch(() => []),
							store.listRepositoryHosts(teamId).catch(() => []),
						]);
						const repositoryHostInventory = repositoryHostRows.some((host) => host.id === 'platform:github:hosted-hubs')
							? repositoryHostRows
							: [
								...repositoryHostRows,
								{
									id: 'platform:github:hosted-hubs',
									type: 'repository',
									provider: 'github',
									ownership: 'treeseed_managed',
									name: 'TreeSeed Hosted Hubs',
									accountLabel: process.env.TREESEED_HOSTED_HUBS_GITHUB_OWNER ?? null,
									organizationOrOwner: process.env.TREESEED_HOSTED_HUBS_GITHUB_OWNER
										?? (typeof requestedRepository?.owner === 'string' ? requestedRepository.owner : null)
										?? (typeof body.repoOwner === 'string' ? body.repoOwner : null)
										?? 'treeseed-sites',
									allowedEnvironments: ['staging', 'prod'],
									status: 'active',
									metadata: { hostType: 'repository', managed: true },
								},
							];
						let hostBindingResolution;
						try {
							hostBindingResolution = resolveProjectLaunchHostBindings({
								hostBindings: normalizedHostBindings,
								launchRequirements: templateLaunchRequirements,
								repositoryHosts: repositoryHostInventory,
								teamHosts: teamWebHosts,
								managedHosts: managedHostInventory,
								defaultHosts: team?.metadata?.defaultHosts && typeof team.metadata.defaultHosts === 'object' ? team.metadata.defaultHosts : {},
								projectSlug: requestedSlug,
								projectName: requestedName,
								standardProjectLaunch: true,
							});
						} catch (error) {
							return jsonError(c, 400, error instanceof Error ? error.message : String(error), { code: 'invalid_host_bindings' });
						}
						const cloudflareHostMode = hostBindingResolution.compatibility.cloudflareHostMode
							?? (body.cloudflareHostMode === 'treeseed_managed' ? 'treeseed_managed' : body.cloudflareHostMode === 'team_owned' ? 'team_owned' : null);
						const cloudflareHostId = hostBindingResolution.compatibility.cloudflareHostId
							?? (typeof body.cloudflareHostId === 'string' && body.cloudflareHostId.trim() ? body.cloudflareHostId.trim() : null);
						const emailHostMode = hostBindingResolution.compatibility.emailHostMode
							?? (body.emailHostMode === 'treeseed_managed' ? 'treeseed_managed' : body.emailHostMode === 'team_owned' ? 'team_owned' : null);
						const emailHostId = hostBindingResolution.compatibility.emailHostId
							?? (typeof body.emailHostId === 'string' && body.emailHostId.trim() ? body.emailHostId.trim() : null);
						let cloudflareHost = null;
					if (cloudflareHostMode === 'team_owned') {
						if (!cloudflareHostId) {
							return jsonError(c, 400, 'cloudflareHostId is required when cloudflareHostMode is team_owned.');
						}
						cloudflareHost = await store.getTeamWebHost(teamId, cloudflareHostId);
						if (!cloudflareHost || cloudflareHost.provider !== 'cloudflare' || cloudflareHost.ownership !== 'team_owned') {
							return jsonError(c, 400, 'Selected team-owned Cloudflare host is not available for this team.');
						}
						if (body.cloudflareHostConfig && typeof body.cloudflareHostConfig === 'object') {
							return jsonError(c, 400, 'Plaintext Cloudflare provider configs are not accepted. Re-enter or migrate this host secret through CLI/Admin client-side flows before launch.', { code: 'sensitive_passphrase_rejected' });
						}
						return jsonError(c, 400, 'Team-owned Cloudflare host secrets must be re-entered or migrated into an approved target before project launch.', { code: 'sensitive_passphrase_rejected' });
					}
						let emailHost = null;
					if (emailHostMode === 'team_owned') {
						if (!emailHostId) {
							return jsonError(c, 400, 'emailHostId is required when emailHostMode is team_owned.');
						}
						emailHost = await store.getTeamWebHost(teamId, emailHostId);
						const hostType = emailHost?.metadata?.hostType;
						if (!emailHost || emailHost.provider !== 'smtp' || emailHost.ownership !== 'team_owned' || hostType !== 'email') {
							return jsonError(c, 400, 'Selected team-owned Email host is not available for this team.');
						}
						if (body.emailHostConfig && typeof body.emailHostConfig === 'object') {
							return jsonError(c, 400, 'Plaintext Email provider configs are not accepted. Re-enter or migrate this host secret through CLI/Admin client-side flows before launch.', { code: 'sensitive_passphrase_rejected' });
						}
						return jsonError(c, 400, 'Team-owned Email host secrets must be re-entered or migrated into an approved target before project launch.', { code: 'sensitive_passphrase_rejected' });
					}
						const cloudflareLaunchConfig = cloudflareHostMode === 'treeseed_managed'
								? await resolveManagedCloudflareHostConfigFromConfig(runtime)
								: null;
						if (cloudflareHostMode === 'treeseed_managed') {
							const missingManagedConfig = managedCloudflareConfigMissing(cloudflareLaunchConfig);
							if (missingManagedConfig.length > 0) {
							return jsonError(c, 500, 'TreeSeed managed Cloudflare hosting is not configured.', {
								missing: missingManagedConfig,
								});
							}
						}
						const targetEnvironments = ['staging', 'prod'];
						const requestedDomains = normalizeProjectDomainInput(body.domains ?? {
							productionDomain: body.productionDomain,
							stagingDomain: body.stagingDomain,
							zoneName: body.cloudflareZoneName,
							zoneId: body.cloudflareZoneId,
							manageDns: body.manageDns,
						});
						const cloudflareDns = cloudflareHostMode === 'team_owned'
							? cloudflareHost?.metadata?.dns ?? {}
							: cloudflareHostMode === 'treeseed_managed'
								? {
									managed: Boolean(cloudflareLaunchConfig?.CLOUDFLARE_ZONE_ID || cloudflareLaunchConfig?.TREESEED_CLOUDFLARE_ZONE_NAME),
									zoneId: cloudflareLaunchConfig?.CLOUDFLARE_ZONE_ID ?? null,
									zoneName: cloudflareLaunchConfig?.TREESEED_CLOUDFLARE_ZONE_NAME ?? null,
								}
								: {};
						const configuredZoneName = normalizeDomainName(requestedDomains.zoneName ?? cloudflareDns.zoneName);
						const inferredZoneName = inferZoneNameForDomain(requestedDomains.productionDomain ?? requestedDomains.stagingDomain, configuredZoneName);
						const domainZoneName = configuredZoneName ?? inferredZoneName;
						if ((requestedDomains.productionDomain || requestedDomains.stagingDomain) && !domainZoneName) {
							return jsonError(c, 400, 'A Cloudflare DNS zone is required when production or staging domains are provided.');
						}
						for (const [label, domain] of [['productionDomain', requestedDomains.productionDomain], ['stagingDomain', requestedDomains.stagingDomain]]) {
							if (domain && !domainInZone(domain, domainZoneName)) {
								return jsonError(c, 400, `${label} must be the selected Cloudflare zone root or a subdomain of it.`);
							}
						}
						if (requestedDomains.productionDomain && requestedDomains.stagingDomain && requestedDomains.productionDomain === requestedDomains.stagingDomain) {
							return jsonError(c, 400, 'Production and staging domains must be different.');
						}
						const projectDomains = {
							productionDomain: requestedDomains.productionDomain,
							stagingDomain: requestedDomains.stagingDomain,
							zoneName: domainZoneName,
							zoneId: requestedDomains.zoneId ?? cloudflareDns.zoneId ?? null,
							manageDns: Boolean(requestedDomains.manageDns && domainZoneName),
							provider: 'cloudflare',
						};
					const cloudflareHostMetadata = cloudflareHostMode
						? {
							mode: cloudflareHostMode,
							hostId: cloudflareHostId,
							hostName: cloudflareHost?.name ?? (cloudflareHostMode === 'treeseed_managed' ? 'TreeSeed Web Host' : null),
							ownership: cloudflareHost?.ownership ?? cloudflareHostMode,
							targetEnvironments,
							dns: cloudflareDns,
							domains: projectDomains,
							billing: cloudflareHostMode === 'treeseed_managed'
								? {
									fee: 'treeseed_cloudflare_hosting',
									status: 'pending_activation',
								}
								: null,
						}
						: null;
						const emailHostMetadata = emailHostMode
						? {
							mode: emailHostMode,
							hostId: emailHostId,
							hostName: emailHost?.name ?? (emailHostMode === 'treeseed_managed' ? 'TreeSeed Email Host' : null),
							ownership: emailHost?.ownership ?? emailHostMode,
							provider: emailHost?.provider ?? 'smtp',
							targetEnvironments,
							billing: emailHostMode === 'treeseed_managed'
								? { fee: 'treeseed_email_hosting', unit: 'email_sent', price: '$0.01/email sent', status: 'pending_activation' }
								: null,
						}
						: null;
						const hostMetadata = {
							...(cloudflareHostMetadata ? { cloudflareHost: cloudflareHostMetadata } : {}),
							...(emailHostMetadata ? { emailHost: emailHostMetadata } : {}),
						};
						const hostBindingMetadata = {
							hostBindings: hostBindingResolution.hostBindings,
							hostBindingPlans: {
								configWrites: hostBindingResolution.configWritePlan,
								secretDeployment: hostBindingResolution.secretDeploymentPlan,
							},
						};
					const repositoryHostId = typeof requestedRepository?.hostId === 'string' && requestedRepository.hostId.trim()
						? requestedRepository.hostId.trim()
						: hostBindingResolution.compatibility.repositoryHostId
							? hostBindingResolution.compatibility.repositoryHostId
							: typeof body.repositoryHostId === 'string' && body.repositoryHostId.trim()
							? body.repositoryHostId.trim()
							: 'platform:github:hosted-hubs';
					let repositoryHost = await store.getRepositoryHost(teamId, repositoryHostId);
					if (!repositoryHost && repositoryHostId === 'platform:github:hosted-hubs') {
						repositoryHost = await store.upsertRepositoryHost(teamId, {
							id: repositoryHostId,
							platformOwner: true,
							provider: 'github',
							ownership: 'treeseed_managed',
							name: 'TreeSeed Hosted Hubs',
							accountLabel: process.env.TREESEED_HOSTED_HUBS_GITHUB_OWNER ?? null,
							organizationOrOwner: process.env.TREESEED_HOSTED_HUBS_GITHUB_OWNER
								?? (typeof requestedRepository?.owner === 'string' ? requestedRepository.owner : null)
								?? (typeof body.repoOwner === 'string' ? body.repoOwner : null)
								?? 'treeseed-sites',
							defaultVisibility: repoVisibility,
							status: 'active',
							createdById: typeof access.principal.id === 'string' ? access.principal.id : null,
							updatedById: typeof access.principal.id === 'string' ? access.principal.id : null,
						});
					}
					if (!repositoryHost) {
						return jsonError(c, 400, 'Selected Repository Host is not available for this team.');
					}
					if (repositoryHost.ownership === 'team_owned') {
						if (body.repositoryHostConfig && typeof body.repositoryHostConfig === 'object') {
							return jsonError(c, 400, 'Plaintext Repository Host provider configs are not accepted. Re-enter or migrate this host secret through CLI/Admin client-side flows before launch.', { code: 'sensitive_passphrase_rejected' });
						}
						return jsonError(c, 400, 'Team-owned Repository Host secrets must be re-entered or migrated into an approved target before project launch.', { code: 'sensitive_passphrase_rejected' });
					}
						const auditHostKinds = ['repository', 'web', 'email'];
					const templateLineage = [{
						kind: sourceKind === 'blank' ? 'blank_hub' : sourceKind,
						ref: sourceRef,
						version: sourceVersion,
						selectedAt: new Date().toISOString(),
						selectedByUserId: access.principal.id ?? null,
						source: 'project_launch',
					}];
					let details;
					try {
						details = await store.createProject(c.req.param('teamId'), {
							id: typeof body.id === 'string' ? body.id : undefined,
							slug: String(requestedSlug),
							name: String(requestedName),
							description: requestedPurpose,
							metadata: {
								publicSite: body.publicSite !== false,
								sourceKind,
								sourceRef,
								sourceVersion,
								templateLineage,
								coreObjective: requestedCoreObjective,
								enableDefaultAgents: body.enableDefaultAgents !== false,
								launchMode: hostingMode,
								launchPhase: 'queued',
								domains: projectDomains,
								...hostMetadata,
								...(typeof body.metadata === 'object' && body.metadata ? body.metadata : {}),
								...hostBindingMetadata,
							},
								entitlementTier: typeof body.entitlementTier === 'string'
									? body.entitlementTier
									: cloudflareHostMode === 'treeseed_managed' || emailHostMode === 'treeseed_managed'
										? 'paid_hosting'
										: 'free',
						});
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						const status = /already in use/u.test(message) ? 409 : 400;
						return jsonError(c, status, message, { code: status === 409 ? 'slug_taken' : 'invalid_slug' });
					}
					await store.upsertProjectHosting(details.project.id, {
						kind: hostingKind,
						registration,
						marketBaseUrl: runtime.resolved.config.baseUrl ?? null,
						sourceRepoOwner: typeof body.sourceRepoOwner === 'string' ? body.sourceRepoOwner : null,
						sourceRepoName: typeof body.sourceRepoName === 'string' ? body.sourceRepoName : null,
						sourceRepoUrl: typeof body.sourceRepoUrl === 'string' ? body.sourceRepoUrl : null,
						sourceRepoWorkflowPath: typeof body.sourceRepoWorkflowPath === 'string' ? body.sourceRepoWorkflowPath : null,
						projectApiBaseUrl: typeof body.projectApiBaseUrl === 'string' ? body.projectApiBaseUrl : null,
						executionOwner: hostingMode === 'managed' ? 'project_api' : 'project_runner',
						metadata: {
							repoProvider,
							repoVisibility,
							publicSite: body.publicSite !== false,
							sourceKind,
							sourceRef,
							launchPhase: 'queued',
							domains: projectDomains,
							...hostMetadata,
							...hostBindingMetadata,
						},
					});
					await store.upsertProjectConnection(details.project.id, {
						mode: hostingMode === 'managed' ? 'hosted' : hostingMode === 'hybrid' ? 'hybrid' : 'self_hosted',
						projectApiBaseUrl: typeof body.projectApiBaseUrl === 'string' ? body.projectApiBaseUrl : null,
						executionOwner: hostingMode === 'managed' ? 'project_api' : 'project_runner',
						metadata: {
							internalPrefix: '/internal/core',
							repoProvider,
							repoVisibility,
							publicSite: body.publicSite !== false,
							sourceKind,
							sourceRef,
							launchPhase: 'queued',
							domains: projectDomains,
							...hostMetadata,
							...hostBindingMetadata,
						},
					});
					const { launchIntent, launchPlan } = await prepareProjectLaunch(context, {
						body, details, hostingKind, hostingMode, projectDomains, repoProvider, repoVisibility,
						sourceKind, sourceRef, hostMetadata, hostBindingMetadata, teamId, team,
						requestedCoreObjective, sourceVersion, repositoryHost, requestedRepository,
						cloudflareHostMetadata, emailHostMetadata, hostBindingResolution,
						cloudflareHostMode, cloudflareHostId, emailHostMode, emailHostId,
						cloudflareHost, cloudflareLaunchConfig, launchRepositoryTopology, canonicalIntent, runtime,
						targetEnvironments,
					});
					return completeProjectLaunch(context, {
						c, body, details, access, teamId, launchIntent, launchPlan, repositoryHost,
						hostBindingResolution, hostBindingMetadata, hostingMode, projectDomains, sourceRef,
						repoVisibility, cloudflareHostMode, cloudflareHostId, emailHostMode, emailHostId,
						runtime, cloudflareLaunchConfig, cloudflareHost, emailHost, auditHostKinds,
					});
				});
}
