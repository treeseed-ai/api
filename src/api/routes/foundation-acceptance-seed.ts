interface AcceptanceActorInput {
	email?: unknown;
	username?: unknown;
	displayName?: unknown;
	userId?: unknown;
	siteRoles?: unknown[];
	teamRole?: unknown;
}

interface AcceptanceActorFixture {
	userId: string | null;
	email: string | null;
	username: string | null;
	accessToken: string;
	sessionId?: string | null;
	expiresAt: string | null;
}

interface AcceptanceSeedRequest {
	namespace?: unknown;
	password?: unknown;
	actors?: Record<string, AcceptanceActorInput>;
	actorsOnly?: boolean;
}

export function installFoundationAcceptanceSeedRoutes(context: any) {
	const { AGENT_PROMOTION_APPROVAL_DECISIONS, AGENT_TASK_SIGNATURES, AUTH_PROVIDERS, AgentSdk, CHECKOUT_COMMERCIAL_OFFER_MODES, CHECKOUT_OFFER_MODES, CHECKOUT_SUBSCRIPTION_OFFER_MODES, DatabaseAuthProvider, FEEDBACK_SCREENSHOT_TYPES, FEEDBACK_TYPES, GITHUB_ACTIONS_OIDC_ISSUER, HOST_KIND_SESSION_KEYS, LOCAL_CONTENT_COLLECTIONS, LOCAL_CONTENT_DEFAULTS, LOCAL_DECISION_TYPE_VALUES, LOCAL_WORK_CONTENT_COLLECTIONS, MARKET_EMAIL_CONFIRMATION_PREFIX, MAX_FEEDBACK_MESSAGE_LENGTH, MAX_FEEDBACK_SCREENSHOT_BYTES, MarketControlPlaneStore, NOTIFICATION_CONTENT_CAPABILITIES, PERSONAL_THEME_COMPILER_VERSION, PLAINTEXT_HOST_CREDENTIAL_FIELD_NAMES, PLATFORM_OPERATION_SCOPES, POSTGRES_AUTH_PROVIDER_ID, PROPOSAL_VERDICT_DECISION_TYPES, RemoteTreeseedClient, RemoteTreeseedOperationsClient, RemoteTreeseedSdkClient, SENSITIVE_QUERY_PARAM_PATTERN, STRIPE_PRICE_MIRROR_OFFER_MODES, STRIPE_PRODUCT_MIRROR_OFFER_MODES, TreeseedOperationsSdk, accountDeletionBlockers, accountDeletionConfirmationMatches, addRelationValue, apiDatabaseUrl, app, appendLaunchDeploymentEvent, appendLaunchPhaseProjection, appendProjectDeletionProgress, applyCommerceRefundState, applyContentPublishResult, applyHubLaunchFailure, applyHubLaunchResult, applySeedWithStore, artifactDownloadPayload, authConfig, authEmailDeliveryFailureDetail, authEmailDeliveryFailureReason, authProviderId, authTokenTimestampMillis, authTokenTimestampSeconds, availabilityAttempts, availabilityRateLimit, backfillUserEmailAddresses, base64Url, base64urlJson, bearerTokenFromRequest, buildCommerceCheckoutMetadata, buildCommerceStripeMetadata, buildGovernanceApprovalProjection, buildGovernanceProjection, buildInfrastructureProjection, buildKnowledgeArtifactProjection, buildKnowledgeProjection, buildLaunchCredentialOverlay, buildWorkdayProjection, canSkipCloudflareCleanupAfterFailedLaunch, canonicalArchitectureTopology, capacity, centralMarketProfile, checkoutGroupKey, checkoutGroupKind, checkoutGroupStatus, ciOperationForAction, cleanFeedbackString, cloudflareDeletionAuthenticationMessage, cloudflareDnsDomainsForHostValidation, cloudflareErrorMessage, cloudflareProjectDeletionResourceNames, cloudflareRequestForLaunchPreflight, cloudflareRequestForProjectDeletion, collectHostingAuditCredentialOverlay, commerceCheckoutError, commerceErrorResponse, commerceStripeLookupKey, commerceStripePriceParams, commerceStripeProductParams, commerceStripeSyncContext, config, configuredAuthProviderId, confirmationUrlFor, consumeReauthentication, contentRelationPolicy, createApiApp, createApiExtension, createCapacityControlPlane, createCipheriv, createClientEncryptedEscrowService, createCommerceCheckoutRun, createCommerceCheckoutRunForServiceContract, createDecipheriv, createDecisionFromProposals, createGitHubActionsSecretEnclave, createGitHubAppAdapter, createHash, createHmac, createMarketEmailConfirmation, createMarketPostgresDatabase, createMarketWebSession, createOrResendUserEmailAddress, createProjectHostCredentialSessions, createProjectInternalClient, createPublicKey, createRelatedLocalContentRecord, createStripeConnectService, createTreeDxCredentialBridge, createTreeseedApiApp, createVerify, credentialSessionKey, credentialSessionSecret, db, decodeRouteParam, decorateJob, decoratePlatformOperation, decryptCredentialSessionPayload, decryptHostConfig, decryptTeamHostForLaunch, decryptedHostConfigSummary, defaultConfig, deleteCloudflareDnsRecordsForProject, deleteCloudflareProjectResources, deleteTeamCapacityAggregate, derivePlatformOperationNavigation, deriveProjectHostBindingsView, domainInZone, encryptCredentialSessionPayload, encryptedHostPayloadLooksValid, enqueueTreeDxProvisionOperation, ensureCommerceStripeCustomer, ensureMarketCredentialSchema, ensurePrincipal, entitlementRenewalStateFromSubscription, enumValue, exchangeProviderIdentity, executeInline, executeProjectApi, executeSdkOperation, existsSync, exportSeedWithStore, exposeAuthTokenForTests, fallbackRemoteCapability, findById, findDispatchCapability, getSiteAuthConfig, getUserEmailAddress, githubOidcJwksCache, githubRequestForProjectDeletion, grantCommerceEntitlementsForOrder, handleCommerceInvoiceWebhook, handleCommercePaymentIntentWebhook, handleCommerceSubscriptionWebhook, hasRecordedCloudflareRuntimeResources, hashMarketPassword, hostBindingRequiresUnlock, hostKindForBinding, hubRepositoryPolicies, inferZoneNameForDomain, installApiRequestLogger, installCapacityRoutes, installProjectDeploymentRoutes, isLocalAcceptanceServicePrincipal, isLoopbackUrl, isPlatformOperationTerminal, isTeamApiPrincipal, isValidPersonalThemeDraft, jsonError, jsonThrownError, launchCapabilityPreset, launchPlannerRepositoryTopology, listCloudflareNamedResources, listTreeseedManagedHostsFromConfig, listUserEmailAddresses, loadGitHubOidcJwks, loadInfrastructureSeedState, loadKnowledgeContentEntries, loadNotificationPreferences, loadProjectHostBindingContext, loadTemplateCatalog, localAcceptanceAdminToken, localAcceptanceAuthEnabled, localContentPath, localContentRoot, logRequests, managedCloudflareConfigMissing, markdownToPlainProjectSummary, marketAuthContext, marketEmailTokenHash, marketProfilesForTeams, mergeCapability, mergeStringConfig, mkdir, nonSecretLaunchJobInput, normalizeAppearancePreference, normalizeAuditHostKinds, normalizeBaseUrl, normalizeCheckoutQuantity, normalizeCiEnvironment, normalizeDomainName, normalizeEmail, normalizeLocalContentInput, normalizeMarketProfile, normalizeNotificationPreferences, normalizeProjectDomainInput, normalizeProjectLaunchHostBindings, normalizeProviderCredentialConfig, normalizeRelationArray, normalizeRepositoryContentInput, normalizeRepositoryRelationArray, normalizeRepositorySlug, normalizeSeedEnvironments, normalizeTemplateLaunchRequirements, normalizeTreeseedTemplateId, normalizeUsername, normalizedCloudflareKvNamespaceReference, operationTokenSecret, optionalTrimmedString, orderStatusFromPaymentGroup, parseBase64urlJson, parseBooleanEnvValue, parseJsonObject, parseYaml, passwordResetUrlFor, patchLaunchIntentForCredentialOverlay, paymentGroupStatusFromPaymentIntent, pbkdf2Sync, persistProjectHostBindingOperationMetadata, personalThemeFromRow, plaintextHostCredentialFieldPaths, planKnowledgeHubLaunch, planProjectHostBindingOperation, planSeedWithStore, platformOperationMutationError, principalCanManageCommerceProduct, principalHasGlobalPlatformRole, principalHasPermission, principalIsSeedAdmin, privateKnowledgeAuditPayload, processCommerceStripeWebhook, projectAllowedCiRepositories, projectApiConnection, projectAppHref, projectDeletionBlockerRows, projectDeletionConfirmationMatches, projectDeletionHostname, projectDeletionOperation, projectHostBindingMetadata, projectHostResponsePayload, providerConfigFor, providerCredentialValuesForAudit, providerJwksCache, publicPaymentGroups, randomBytes, randomUUID, readCapacityRequestObject, readFile, readJsonOrFormBody, readLocalContentRecord, recordContentNotificationEvent, recordFeedbackSubmission, recordPrivateKnowledgeAudit, redactCommerceOwnershipWorkflow, redactCommerceServiceRequestForBuyer, redactedRequestTarget, refreshCommercePaymentGroupState, refreshCommerceStripeAccount, rejectPlaintextHostCredentialFields, rejectProjectSecretUnlockMaterial, relative, remainingRefundableAmount, repositoryContentRelationPolicy, repositoryInventoryWithPlatform, requestClientIp, requestSessionMetadata, requireCatalogItemAccess, requireCommerceCapacityInquiryAccess, requireCommerceCapacityListingAccess, requireCommerceOfferAccess, requireCommerceProductAccess, requireCommerceVendorForStripe, requireConfiguredServiceCredential, requireConnectedProjectRuntime, requirePlatformRunner, requireProjectAccess, requireProjectRunner, requireSeedApplyAccess, requireSeedPlanAccess, requireSellerTeamAccess, requireServiceBuyerAccess, requireServiceParticipantAccess, requireServiceSellerAccess, requireTeamAccess, requireVendorOrderManager, resolve, resolveAgentArtifactBucket, resolveAgentTaskSignature, resolveApiConfig, resolveAuthApprovalBaseUrl, resolveCloudflareZoneForLaunchPreflight, resolveCommerceCheckoutItem, resolveFulfillmentArtifact, resolveLaunchTemplateRequirements, resolveOrderItemForRefund, resolvePlatformRepositoryDescriptor, resolvePlatformRunnerSecret, resolveProjectDeletionCloudflareZone, resolveProjectLaunchHostBindings, resolvePublicTreeDxTeam, resolveStripeEnvironment, resolveStripePublishableKey, resolveStripeWebhookSecret, resolveTreeseedManagedCloudflareHostConfigFromConfig, resolveUiProjectionContext, resourceRowsFromLaunch, retryApiLaunchBootstrapFromRequest, rm, runProjectDeletionApiDestroy, runProjectLaunchApiBootstrap, runTreeseedHostingAudit, runtime, runtimeMarketAuthProvider, runtimeProviders, safeFeedbackClient, safeFeedbackContext, safeFeedbackScreenshot, safePlatformOperationOutput, safePrivateKnowledgeSlug, safeTokenEquals, sanitizeLaunchResultForStorage, sanitizedReturnTo, scheduleBackgroundBootstrap, seedActor, seedCreatesMissingTeams, seedExistingTeamIds, selectDispatchTarget, sendAuthEmail, sendEmailConfirmation, sendTeamInviteEmail, sendWelcomeEmail, serializeFrontmatter, serializeUserEmailAddress, setPrimaryEmailAddress, sharedSdk, shouldBypassAcceptanceAuthEmailDelivery, shouldExposeNonProductionAuthDiagnostics, shouldLogApiRequests, signEditorialPreviewToken, signOperationToken, slugifyContent, slugifyRepositoryContent, sourceFromProjectDetails, store, stripeAccountMissingError, stripeAccountToConnectedAccountPatch, stripeClientSecret, stripeCommerceUrl, stripeConfiguredError, stripeConnectService, stripeMetadataValue, stripePriceTermsDrift, stripeRefundStatus, stripeTimestampToIso, stripeVendorApprovalError, subscriptionClientSecret, subscriptionStatusFromStripe, syncCommerceOfferStripeProduct, syncCommercePriceStripePrice, syncCommerceSubscriptionFromStripe, syncPrimaryEmailCaches, teamInviteAcceptUrlFor, timingSafeEqual, trimmedHeaderValue, uiRuntimeLocals, uniqueCloudflareKvNamespaceReferences, uniqueRelationArray, unknownKeys, unwrapLaunchOperationOutput, unwrapOperationPayload, updateCheckoutCompletionFromGroup, updateLaunchDeployments, validateCiRefForEnvironment, validateFeedbackAccess, validateMarketPassword, validateProjectSlug, validatePublicUsername, validateTeamHostCredentialPayload, verifiedEmailCount, verifyCloudflareDnsWriteForLaunch, verifyGitHubOidcToken, verifyMarketPassword, verifyOperationToken, verifyProviderIdToken, webAuthPayload, webSessionData, writeFile, writeLocalContentRecord, writeParsedLocalContentRecord, yamlLines, yamlScalar } = context;
	app.post('/v1/acceptance/seed', async (c) => {
					const service = requireConfiguredServiceCredential(c, runtime.resolved.config);
					if (service.response) return service.response;
					await ensureMarketCredentialSchema(store);
					const body = await c.req.json().catch(() => ({})) as AcceptanceSeedRequest;
					const namespace = optionalTrimmedString(body.namespace) ?? `acceptance-${runtime.resolved.config.environment ?? 'local'}`;
					const password = optionalTrimmedString(body.password) ?? `TreeSeed-${namespace}-acceptance-123!`;
					const actorInputs: Record<string, AcceptanceActorInput> = body.actors && typeof body.actors === 'object'
						? body.actors
						: {
							siteAdmin: { siteRoles: ['platform_admin'] },
							marketSteward: { siteRoles: ['market_admin'] },
							teamOwner: { siteRoles: ['member'], teamRole: 'team_owner' },
							teamOperator: { siteRoles: ['member'], teamRole: 'contributor' },
							teamViewer: { siteRoles: ['viewer'], teamRole: 'reviewer' },
							nonMember: { siteRoles: ['viewer'] },
							providerOperator: { siteRoles: ['member'] },
						};
					const actors: Record<string, AcceptanceActorFixture> = {};
					try {
					for (const [actorId, actorInput] of Object.entries(actorInputs)) {
						const safeActorId = String(actorId).replace(/[^a-z0-9-]+/giu, '-').replace(/^-+|-+$/gu, '').toLowerCase() || 'actor';
						const email = normalizeEmail(actorInput.email) || `treeseed+${namespace}-${safeActorId}@treeseed.ai`;
						const safeNamespace = namespace.replace(/[^a-z0-9-]+/giu, '-').replace(/^-+|-+$/gu, '').toLowerCase() || 'acceptance';
						const actorSuffix = safeActorId.slice(-16) || 'actor';
						const namespaceLimit = Math.max(1, 39 - actorSuffix.length - 1);
						const username = normalizeUsername(actorInput.username)
							|| `${safeNamespace.slice(0, namespaceLimit).replace(/-+$/gu, '')}-${actorSuffix}`.replace(/^-+|-+$/gu, '')
							|| actorSuffix;
						const displayName = optionalTrimmedString(actorInput.displayName) ?? `Acceptance ${actorId}`;
						const requestedUserId = process.env.NODE_ENV === 'test' ? optionalTrimmedString(actorInput.userId) : null;
						let synced;
						if (requestedUserId) {
							const timestamp = new Date().toISOString();
							await store.run(`INSERT INTO users (id, email, username, display_name, status, metadata_json, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', ?, ?, ?) ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email, username = EXCLUDED.username, display_name = EXCLUDED.display_name, status = 'active', metadata_json = EXCLUDED.metadata_json, updated_at = EXCLUDED.updated_at`, [requestedUserId, email, username, displayName, JSON.stringify({ username, acceptance: true, namespace, actorId }), timestamp, timestamp]);
							await store.run(`INSERT INTO user_identities (id, user_id, provider, provider_subject, email, email_verified, profile_json, created_at, updated_at) VALUES (?, ?, 'acceptance', ?, ?, 1, ?, ?, ?) ON CONFLICT (provider, provider_subject) DO UPDATE SET user_id = EXCLUDED.user_id, email = EXCLUDED.email, email_verified = 1, profile_json = EXCLUDED.profile_json, updated_at = EXCLUDED.updated_at`, [randomUUID(), requestedUserId, `${namespace}:${actorId}`, email, JSON.stringify({ acceptance: true, namespace, actorId }), timestamp, timestamp]);
							synced = { principal: { id: requestedUserId, metadata: { username } } };
						} else {
							synced = await runtimeMarketAuthProvider.syncUserIdentity({
								provider: 'acceptance', providerSubject: `${namespace}:${actorId}`, email, emailVerified: true, username, displayName,
								profile: { acceptance: true, namespace, actorId },
							});
						}
						if (runtimeMarketAuthProvider.setUserRoles) {
							await runtimeMarketAuthProvider.setUserRoles(synced.principal.id, Array.isArray(actorInput.siteRoles) ? actorInput.siteRoles.map(String) : ['viewer']);
						}
						const now = new Date().toISOString();
						await store.run(`DELETE FROM market_auth_credentials WHERE user_id = ? OR email = ? OR username = ?`, [synced.principal.id, email, username]);
						await store.run(
							`INSERT INTO market_auth_credentials (user_id, email, username, password_hash, status, created_at, updated_at)
							 VALUES (?, ?, ?, ?, 'active', ?, ?)`,
							[synced.principal.id, email, username, hashMarketPassword(password), now, now],
						);
						await store.run(`DELETE FROM user_email_addresses WHERE user_id = ? OR normalized_email = ?`, [synced.principal.id, email]).catch(() => null);
						await store.run(
							`INSERT INTO user_email_addresses (
								id, user_id, email, normalized_email, status, is_primary, verification_requested_at, verified_at, created_at, updated_at
							) VALUES (?, ?, ?, ?, 'verified', 1, ?, ?, ?, ?)`,
							[randomUUID(), synced.principal.id, email, email, now, now, now, now],
						).catch(() => null);
						const session = await createMarketWebSession(runtimeMarketAuthProvider, synced.principal.id, {
							source: 'acceptance_seed',
							namespace,
							actorId,
						}, { store, authSecret: runtime.resolved.config.authSecret });
						actors[actorId] = {
							userId: synced.principal.id,
							email,
							username,
							accessToken: session.accessToken,
							sessionId: session.principal?.metadata?.sessionId ?? null,
							expiresAt: session.expiresAt ?? null,
						};
					}
					if (body.actorsOnly === true) {
						return c.json({ ok: true, payload: { namespace, password, actors, fixtures: {} } });
					}
					let team = null;
					let project = null;
					const teamSlug = `${namespace}-team`.replace(/[^a-z0-9-]+/gu, '-').slice(0, 39).replace(/^-+|-+$/gu, '') || 'acceptance-team';
					const existingTeam = await store.first(`SELECT * FROM teams WHERE slug = ? LIMIT 1`, [teamSlug]).catch(() => null);
					const owner = actors.teamOwner ?? actors.siteAdmin ?? Object.values(actors)[0];
						team = existingTeam ?? await store.createTeam({
							id: `team-${teamSlug}`,
							name: teamSlug,
							displayName: `Acceptance ${namespace}`,
							ownerUserId: owner?.userId,
							metadata: { acceptance: true, namespace },
						});
						let treeDx = await store.getTeamTreeDx(team.id);
						if (!treeDx?.instance) {
							treeDx = await store.provisionTeamTreeDx(team.id, {
								metadata: {
									automaticPrivateTeamTreeDx: true,
									createdFrom: 'acceptance_fixture',
									acceptance: true,
									namespace,
								},
							});
						}
					for (const [actorId, actorInput] of Object.entries(actorInputs)) {
						if (!actorInput.teamRole || !actors[actorId]?.userId) continue;
						await store.upsertTeamMember(team.id, actors[actorId].userId, String(actorInput.teamRole));
					}
					const ownerMembership = await store.first(
						`SELECT * FROM team_memberships WHERE team_id = ? AND user_id = ? LIMIT 1`,
						[team.id, owner?.userId],
					).catch(() => null);
					const membershipFixtures = {};
					for (const actorId of Object.keys(actors)) {
						const actor = actors[actorId];
						if (!actor?.userId) continue;
						const membership = await store.first(
							`SELECT * FROM team_memberships WHERE team_id = ? AND user_id = ? LIMIT 1`,
							[team.id, actor.userId],
						).catch(() => null);
						if (membership?.id) membershipFixtures[actorId] = { id: membership.id, roleKey: membership.role_key ?? membership.role ?? null };
					}
					const projectSlug = `${namespace}-project`.replace(/[^a-z0-9-]+/gu, '-').slice(0, 39).replace(/^-+|-+$/gu, '') || 'acceptance-project';
					const acceptanceProjectArchitecture = {
						topology: 'single_repository_site',
						rootPath: '.',
						sitePath: '.',
						contentPath: 'src/content',
						contentRuntimeSource: 'treedx_snapshot',
						localContentMaterialization: 'none',
						contentPublishTarget: {
							kind: 'cloudflare_r2',
							prefix: `${projectSlug}/content`,
						},
					};
					project = await store.first(`SELECT * FROM projects WHERE team_id = ? AND slug = ? LIMIT 1`, [team.id, projectSlug]).catch(() => null);
						if (!project) {
							const details = await store.createProject(team.id, {
								id: `project-${projectSlug}`,
								slug: projectSlug,
								name: `Acceptance ${namespace}`,
							description: 'Reserved live acceptance fixture.',
							metadata: { acceptance: true, namespace, architecture: acceptanceProjectArchitecture },
						});
							project = details.project ?? details;
						}
						await store.upsertProjectTreeDxLibrary(project.id, {
							contentPath: 'src/content',
							metadata: {
								acceptance: true,
								namespace,
								source: 'acceptance_fixture',
								privateTeamTreeDxDefault: true,
							},
						}).catch(() => null);
						await store.upsertHubRepository(project.id, {
						teamId: team.id,
						role: 'software',
						provider: 'github',
						owner: 'treeseed-acceptance',
						name: projectSlug,
						url: `https://github.com/treeseed-acceptance/${projectSlug}`,
						defaultBranch: 'staging',
						status: 'ready',
						metadata: { acceptance: true, namespace, workflowFile: 'deploy-web.yml' },
					}).catch(() => null);
					const acceptanceWebHostId = `web-host-${namespace}`.replace(/[^a-z0-9-]+/giu, '-').slice(0, 96);
					const existingWebHost = await store.getTeamWebHost?.(team.id, acceptanceWebHostId).catch(() => null);
					if (!existingWebHost) {
						await store.createTeamWebHost(team.id, {
							id: acceptanceWebHostId,
							provider: 'cloudflare',
							ownership: 'team_owned',
							name: `Acceptance ${namespace} Web`,
							accountLabel: 'Acceptance Cloudflare',
							allowedEnvironments: ['staging', 'prod'],
							status: 'active',
							encryptedPayload: {
								version: 1,
								algorithm: 'acceptance-redacted',
								kdf: {},
								salt: 'acceptance',
								nonce: 'acceptance',
								ciphertext: 'redacted',
							},
							metadata: { acceptance: true, namespace },
							createdById: owner?.userId,
						}).catch(() => null);
					}
					const acceptanceLaunchRequirements = await resolveLaunchTemplateRequirements({
						store,
						principal: { id: owner?.userId ?? 'acceptance', roles: ['platform_admin'] },
						config: runtime.resolved.config,
						sourceKind: 'template',
						sourceRef: 'research',
						requireKnownTemplate: true,
					});
					const acceptanceManagedHosts = (await listTreeseedManagedHostsFromConfig(team.id, runtime).catch(() => []))
						.map((host) => host.id === 'treeseed-managed-web'
							? {
								...host,
								status: 'active',
								metadata: {
									...(host.metadata ?? {}),
									configured: true,
									missingConfigKeys: [],
								},
							}
							: host);
					const acceptanceHostBindingResolution = resolveProjectLaunchHostBindings({
						hostBindings: normalizeProjectLaunchHostBindings({
							hostBindings: {
								sourceRepository: {
									requirementKind: 'host',
									type: 'repository',
									provider: 'github',
									hostId: 'platform:github:hosted-hubs',
									mode: 'treeseed_managed',
								},
								publicWeb: {
									requirementKind: 'host',
									type: 'web',
									provider: 'cloudflare',
									managedHostKey: 'treeseed-managed-web',
									mode: 'treeseed_managed',
								},
								transactionalEmail: {
									requirementKind: 'host',
									type: 'email',
									provider: 'smtp',
									managedHostKey: 'treeseed-managed-email',
									mode: 'treeseed_managed',
								},
							},
						}),
						launchRequirements: acceptanceLaunchRequirements,
						repositoryHosts: repositoryInventoryWithPlatform([], 'treeseed-acceptance'),
						teamHosts: [],
						managedHosts: acceptanceManagedHosts,
						defaultHosts: team?.metadata?.defaultHosts && typeof team.metadata.defaultHosts === 'object' ? team.metadata.defaultHosts : {},
						projectSlug,
						projectName: project.name,
						standardProjectLaunch: true,
					});
					project = await store.updateProject(project.id, {
						metadata: {
							...(project.metadata ?? {}),
							acceptance: true,
							namespace,
							architecture: acceptanceProjectArchitecture,
							sourceKind: 'template',
							sourceRef: 'research',
							hostBindings: acceptanceHostBindingResolution.hostBindings,
							hostBindingPlans: {
								configWrites: acceptanceHostBindingResolution.configWritePlan,
								secretDeployment: acceptanceHostBindingResolution.secretDeploymentPlan,
							},
						},
					}) ?? project;
					await store.upsertProjectEnvironment(project.id, {
						environment: 'staging',
						deploymentProfile: 'hosted_project',
						baseUrl: `https://${projectSlug}.staging.example.test`,
						pagesProjectName: projectSlug,
						metadata: { acceptance: true, namespace },
					}).catch(() => null);
					await store.upsertProjectEnvironment(project.id, {
						environment: 'prod',
						deploymentProfile: 'hosted_project',
						baseUrl: `https://${projectSlug}.example.test`,
						pagesProjectName: projectSlug,
						metadata: { acceptance: true, namespace },
					}).catch(() => null);
					const workday = await capacity.createWorkdayCapacityEnvelope({
						id: `workday-${namespace}`.replace(/[^a-z0-9-]+/giu, '-').slice(0, 96),
						projectId: project.id,
						status: 'draft',
						metadata: { acceptance: true, namespace },
					}).catch(() => null);
					const operation = await store.createPlatformOperation({
						id: `operation-${namespace}`.replace(/[^a-z0-9-]+/giu, '-').slice(0, 96),
						namespace: 'market',
						operation: 'noop',
						status: 'queued',
						target: 'market_operations_runner',
						idempotencyKey: `acceptance-${namespace}`,
						input: { acceptance: true, namespace },
						requestedByType: 'service',
						requestedById: 'acceptance',
					}).catch(() => null);
					const platformRunnerId = `treeseed-ops-${namespace}-1`.replace(/[^a-z0-9-]+/giu, '-').slice(0, 96);
					const platformRunnerDataDir = resolve(process.cwd(), '.treeseed/acceptance-runners', namespace);
					const platformRunner = await store.upsertMarketOperationRunner({
						runnerId: platformRunnerId,
						name: `Acceptance ${namespace} Runner`,
						environment: runtime.resolved.config.environment ?? 'local',
						capabilities: ['market:noop', 'project:web_deployment'],
						maxConcurrentJobs: 1,
						metadata: { acceptance: true, namespace, dataDir: platformRunnerDataDir },
					}).catch(() => null);
					const catalogItem = await store.upsertCatalogItem(team.id, {
						id: `catalog-${namespace}`.replace(/[^a-z0-9-]+/giu, '-').slice(0, 96),
						kind: 'template',
						slug: `${namespace}-template`.replace(/[^a-z0-9-]+/gu, '-').slice(0, 64),
						title: `Acceptance ${namespace} Template`,
						summary: 'Reserved acceptance catalog fixture.',
						visibility: 'public',
						listingEnabled: true,
						offerMode: 'public',
						metadata: { acceptance: true, namespace },
					}).catch(() => null);
					const catalogArtifact = catalogItem ? await store.upsertCatalogArtifactVersion(team.id, catalogItem.id, {
						id: `artifact-${namespace}`.replace(/[^a-z0-9-]+/giu, '-').slice(0, 96),
						kind: 'template',
						version: '1.0.0',
						contentKey: `acceptance/${namespace}/template.tgz`,
						manifestKey: `acceptance/${namespace}/manifest.json`,
						metadata: { acceptance: true, namespace },
					}).catch(() => null) : null;
					const seedRun = await store.first(`SELECT * FROM seed_runs WHERE id = ? LIMIT 1`, [`seed-${namespace}`]).catch(() => null)
						?? await store.createSeedRun({
							id: `seed-${namespace}`.replace(/[^a-z0-9-]+/giu, '-').slice(0, 96),
							seedName: 'acceptance',
							seedVersion: 1,
							environments: [runtime.resolved.config.environment ?? 'local'],
							mode: 'plan',
							state: 'completed',
							actorType: 'service',
							actorId: 'acceptance',
							manifestHash: `acceptance-${namespace}`,
							plan: { acceptance: true, namespace },
							result: { ok: true },
							completedAt: new Date().toISOString(),
						}).catch(() => null);
					const invite = await store.createTeamInvite(team.id, {
						email: `treeseed+${namespace}-invite@treeseed.ai`,
						roleKey: 'reviewer',
						invitedByUserId: owner?.userId,
						autoAddExisting: false,
					}).catch(() => null);
					const approvalRequest = await store.first(`SELECT * FROM approval_requests WHERE id = ? LIMIT 1`, [`approval-${namespace}`]).catch(() => null)
						?? await store.createApprovalRequest({
							id: `approval-${namespace}`.replace(/[^a-z0-9-]+/giu, '-').slice(0, 96),
							teamId: team.id,
							projectId: project.id,
							kind: 'acceptance',
							severity: 'low',
							requestedByType: 'service',
							requestedById: 'acceptance',
							title: 'Acceptance approval request',
							summary: 'Reserved acceptance approval fixture.',
							options: [{ id: 'approve', label: 'Approve' }],
							metadata: { acceptance: true, namespace },
						}).catch(() => null);
					const decisionId = `decision-${namespace}`.replace(/[^a-z0-9-]+/giu, '-').slice(0, 96);
					const decisionPlanningStatus = await capacity.upsertDecisionPlanningStatus({
						id: `dps-${namespace}`.replace(/[^a-z0-9-]+/giu, '-').slice(0, 96),
						projectId: project.id,
						decisionId,
						executionReadiness: 'draft',
						planningInputsStatus: 'requested',
						metadata: { acceptance: true, namespace },
					}).catch(() => null);
					const resetToken = `reset_acceptance_${namespace}`;
					await store.run(
						`INSERT INTO market_auth_password_resets (id, user_id, token_hash, expires_at, used_at, created_at)
						 VALUES (?, ?, ?, ?, NULL, ?)
						 ON CONFLICT(id) DO UPDATE SET token_hash = excluded.token_hash, expires_at = excluded.expires_at, used_at = NULL`,
						[
							`reset-${namespace}`,
							actors.teamOwner?.userId ?? owner?.userId,
							createHash('sha256').update(resetToken).digest('hex'),
							new Date(Date.now() + 60 * 60 * 1000).toISOString(),
							new Date().toISOString(),
						],
					).catch(() => null);
					const platformRunnerSecret = resolvePlatformRunnerSecret(runtime.resolved.config);
					if (platformRunnerSecret) {
						actors.platformRunner = {
							userId: null,
							email: null,
							username: platformRunnerId,
							accessToken: platformRunnerSecret,
							expiresAt: null,
						};
					}
					return c.json({
						ok: true,
						payload: {
							namespace,
							password,
							actors,
							fixtures: {
									team: { id: team.id, slug: team.slug ?? teamSlug },
									project: { id: project.id, slug: project.slug ?? projectSlug },
									treeDx: { id: treeDx?.instance?.id ?? null, mirrorCount: treeDx?.mirrors?.length ?? 0 },
								membership: { id: ownerMembership?.id ?? null },
								memberships: membershipFixtures,
								session: { id: actors.teamOwner?.sessionId ?? actors.siteAdmin?.sessionId ?? null },
								workday: { id: workday?.id ?? `workday-${namespace}` },
								job: { id: operation?.id ?? `operation-${namespace}` },
								platformOperation: { id: operation?.id ?? `operation-${namespace}` },
								platformRunner: { id: platformRunner?.id ?? platformRunnerId },
								catalogItem: { id: catalogItem?.id ?? `catalog-${namespace}`, slug: catalogItem?.slug ?? `${namespace}-template` },
								catalogArtifact: { id: catalogArtifact?.id ?? `artifact-${namespace}`, version: catalogArtifact?.version ?? '1.0.0' },
								seedRun: { id: seedRun?.id ?? `seed-${namespace}` },
								invite: { id: invite?.invite?.id ?? null },
								approvalRequest: { id: approvalRequest?.id ?? `approval-${namespace}` },
								decision: { id: decisionPlanningStatus?.decisionId ?? decisionId },
								passwordReset: { token: resetToken },
								host: { id: acceptanceWebHostId },
								environment: { id: 'staging' },
							},
						},
					});
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						console.error('Acceptance seed failed', {
							message,
							name: error instanceof Error ? error.name : typeof error,
							stack: error instanceof Error ? error.stack?.split('\n').slice(0, 6).join('\n') : undefined,
						});
						return c.json({
							ok: false,
							error: 'Acceptance seed failed.',
							details: {
								message,
								name: error instanceof Error ? error.name : typeof error,
							},
						}, { status: 500 });
					}
				});
}
