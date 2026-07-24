export function installProjectsHostLifecycleAndSummaryRoutes(context: any) {
	const { AGENT_PROMOTION_APPROVAL_DECISIONS, AGENT_TASK_SIGNATURES, AUTH_PROVIDERS, AgentSdk, CHECKOUT_COMMERCIAL_OFFER_MODES, CHECKOUT_OFFER_MODES, CHECKOUT_SUBSCRIPTION_OFFER_MODES, DatabaseAuthProvider, FEEDBACK_SCREENSHOT_TYPES, FEEDBACK_TYPES, GITHUB_ACTIONS_OIDC_ISSUER, HOST_KIND_SESSION_KEYS, LOCAL_CONTENT_COLLECTIONS, LOCAL_CONTENT_DEFAULTS, LOCAL_DECISION_TYPE_VALUES, LOCAL_WORK_CONTENT_COLLECTIONS, MARKET_EMAIL_CONFIRMATION_PREFIX, MAX_FEEDBACK_MESSAGE_LENGTH, MAX_FEEDBACK_SCREENSHOT_BYTES, MarketControlPlaneStore, NOTIFICATION_CONTENT_CAPABILITIES, PERSONAL_THEME_COMPILER_VERSION, PLAINTEXT_HOST_CREDENTIAL_FIELD_NAMES, PLATFORM_OPERATION_SCOPES, POSTGRES_AUTH_PROVIDER_ID, PROPOSAL_VERDICT_DECISION_TYPES, RemoteTreeseedClient, RemoteTreeseedOperationsClient, RemoteTreeseedSdkClient, SENSITIVE_QUERY_PARAM_PATTERN, STRIPE_PRICE_MIRROR_OFFER_MODES, STRIPE_PRODUCT_MIRROR_OFFER_MODES, TreeseedOperationsSdk, accountDeletionBlockers, accountDeletionConfirmationMatches, addRelationValue, apiDatabaseUrl, app, appendLaunchDeploymentEvent, appendLaunchPhaseProjection, appendProjectDeletionProgress, applyCommerceRefundState, applyContentPublishResult, applyHubLaunchFailure, applyHubLaunchResult, applySeedWithStore, artifactDownloadPayload, authConfig, authEmailDeliveryFailureDetail, authEmailDeliveryFailureReason, authProviderId, authTokenTimestampMillis, authTokenTimestampSeconds, availabilityAttempts, availabilityRateLimit, backfillUserEmailAddresses, base64Url, base64urlJson, bearerTokenFromRequest, buildCommerceCheckoutMetadata, buildCommerceStripeMetadata, buildGovernanceApprovalProjection, buildGovernanceProjection, buildInfrastructureProjection, buildKnowledgeArtifactProjection, buildKnowledgeProjection, buildLaunchCredentialOverlay, buildWorkdayProjection, canSkipCloudflareCleanupAfterFailedLaunch, canonicalArchitectureTopology, capacity, centralMarketProfile, checkoutGroupKey, checkoutGroupKind, checkoutGroupStatus, ciOperationForAction, cleanFeedbackString, cloudflareDeletionAuthenticationMessage, cloudflareDnsDomainsForHostValidation, cloudflareErrorMessage, cloudflareProjectDeletionResourceNames, cloudflareRequestForLaunchPreflight, cloudflareRequestForProjectDeletion, collectHostingAuditCredentialOverlay, commerceCheckoutError, commerceErrorResponse, commerceStripeLookupKey, commerceStripePriceParams, commerceStripeProductParams, commerceStripeSyncContext, config, configuredAuthProviderId, confirmationUrlFor, consumeReauthentication, contentRelationPolicy, createApiApp, createApiExtension, createCapacityControlPlane, createCipheriv, createClientEncryptedEscrowService, createCommerceCheckoutRun, createCommerceCheckoutRunForServiceContract, createDecipheriv, createDecisionFromProposals, createGitHubActionsSecretEnclave, createGitHubAppAdapter, createHash, createHmac, createMarketEmailConfirmation, createMarketPostgresDatabase, createMarketWebSession, createOrResendUserEmailAddress, createProjectHostCredentialSessions, createProjectInternalClient, createPublicKey, createRelatedLocalContentRecord, createStripeConnectService, createTreeDxCredentialBridge, createTreeseedApiApp, createVerify, credentialSessionKey, credentialSessionSecret, db, decodeRouteParam, decorateJob, decoratePlatformOperation, decryptCredentialSessionPayload, decryptHostConfig, decryptTeamHostForLaunch, decryptedHostConfigSummary, defaultConfig, deleteCloudflareDnsRecordsForProject, deleteCloudflareProjectResources, deleteTeamCapacityAggregate, derivePlatformOperationNavigation, deriveProjectHostBindingsView, domainInZone, encryptCredentialSessionPayload, encryptedHostPayloadLooksValid, enqueueTreeDxProvisionOperation, ensureCommerceStripeCustomer, ensureMarketCredentialSchema, ensurePrincipal, entitlementRenewalStateFromSubscription, enumValue, exchangeProviderIdentity, executeInline, executeProjectApi, executeSdkOperation, existsSync, exportSeedWithStore, exposeAuthTokenForTests, fallbackRemoteCapability, findById, findDispatchCapability, getSiteAuthConfig, getUserEmailAddress, githubOidcJwksCache, githubRequestForProjectDeletion, grantCommerceEntitlementsForOrder, handleCommerceInvoiceWebhook, handleCommercePaymentIntentWebhook, handleCommerceSubscriptionWebhook, hasRecordedCloudflareRuntimeResources, hashMarketPassword, hostBindingRequiresUnlock, hostKindForBinding, hubRepositoryPolicies, inferZoneNameForDomain, installApiRequestLogger, installCapacityRoutes, installProjectDeploymentRoutes, isLocalAcceptanceServicePrincipal, isLoopbackUrl, isPlatformOperationTerminal, isTeamApiPrincipal, isValidPersonalThemeDraft, jsonError, jsonThrownError, launchCapabilityPreset, launchPlannerRepositoryTopology, listCloudflareNamedResources, listTreeseedManagedHostsFromConfig, listUserEmailAddresses, loadGitHubOidcJwks, loadInfrastructureSeedState, loadKnowledgeContentEntries, loadNotificationPreferences, loadProjectHostBindingContext, loadTemplateCatalog, localAcceptanceAdminToken, localAcceptanceAuthEnabled, localContentPath, localContentRoot, logRequests, managedCloudflareConfigMissing, markdownToPlainProjectSummary, marketAuthContext, marketEmailTokenHash, marketProfilesForTeams, mergeCapability, mergeStringConfig, mkdir, nonSecretLaunchJobInput, normalizeAppearancePreference, normalizeAuditHostKinds, normalizeBaseUrl, normalizeCheckoutQuantity, normalizeCiEnvironment, normalizeDomainName, normalizeEmail, normalizeLocalContentInput, normalizeMarketProfile, normalizeNotificationPreferences, normalizeProjectDomainInput, normalizeProjectLaunchHostBindings, normalizeProviderCredentialConfig, normalizeRelationArray, normalizeRepositoryContentInput, normalizeRepositoryRelationArray, normalizeRepositorySlug, normalizeSeedEnvironments, normalizeTemplateLaunchRequirements, normalizeTreeseedTemplateId, normalizeUsername, normalizedCloudflareKvNamespaceReference, operationTokenSecret, optionalTrimmedString, orderStatusFromPaymentGroup, parseBase64urlJson, parseBooleanEnvValue, parseJsonObject, parseYaml, passwordResetUrlFor, patchLaunchIntentForCredentialOverlay, paymentGroupStatusFromPaymentIntent, pbkdf2Sync, persistProjectHostBindingOperationMetadata, personalThemeFromRow, plaintextHostCredentialFieldPaths, planKnowledgeHubLaunch, planProjectHostBindingOperation, planSeedWithStore, platformOperationMutationError, principalCanManageCommerceProduct, principalHasGlobalPlatformRole, principalHasPermission, principalIsSeedAdmin, privateKnowledgeAuditPayload, processCommerceStripeWebhook, projectAllowedCiRepositories, projectApiConnection, projectAppHref, projectDeletionBlockerRows, projectDeletionConfirmationMatches, projectDeletionHostname, projectDeletionOperation, projectHostBindingMetadata, projectHostResponsePayload, providerConfigFor, providerCredentialValuesForAudit, providerJwksCache, publicPaymentGroups, randomBytes, randomUUID, readCapacityRequestObject, readFile, readJsonOrFormBody, readLocalContentRecord, recordContentNotificationEvent, recordFeedbackSubmission, recordPrivateKnowledgeAudit, redactCommerceOwnershipWorkflow, redactCommerceServiceRequestForBuyer, redactedRequestTarget, refreshCommercePaymentGroupState, refreshCommerceStripeAccount, rejectPlaintextHostCredentialFields, rejectProjectSecretUnlockMaterial, relative, remainingRefundableAmount, repositoryContentRelationPolicy, repositoryInventoryWithPlatform, requestClientIp, requestSessionMetadata, requireCatalogItemAccess, requireCommerceCapacityInquiryAccess, requireCommerceCapacityListingAccess, requireCommerceOfferAccess, requireCommerceProductAccess, requireCommerceVendorForStripe, requireConfiguredServiceCredential, requireConnectedProjectRuntime, requirePlatformRunner, requireProjectAccess, requireProjectRunner, requireSeedApplyAccess, requireSeedPlanAccess, requireSellerTeamAccess, requireServiceBuyerAccess, requireServiceParticipantAccess, requireServiceSellerAccess, requireTeamAccess, requireVendorOrderManager, resolve, resolveAgentArtifactBucket, resolveAgentTaskSignature, resolveApiConfig, resolveAuthApprovalBaseUrl, resolveCloudflareZoneForLaunchPreflight, resolveCommerceCheckoutItem, resolveFulfillmentArtifact, resolveLaunchTemplateRequirements, resolveOrderItemForRefund, resolvePlatformRepositoryDescriptor, resolvePlatformRunnerSecret, resolveProjectDeletionCloudflareZone, resolveProjectLaunchHostBindings, resolvePublicTreeDxTeam, resolveStripeEnvironment, resolveStripePublishableKey, resolveStripeWebhookSecret, resolveTreeseedManagedCloudflareHostConfigFromConfig, resolveUiProjectionContext, resourceRowsFromLaunch, retryApiLaunchBootstrapFromRequest, rm, runProjectDeletionApiDestroy, runProjectLaunchApiBootstrap, runTreeseedHostingAudit, runtime, runtimeMarketAuthProvider, runtimeProviders, safeFeedbackClient, safeFeedbackContext, safeFeedbackScreenshot, safePlatformOperationOutput, safePrivateKnowledgeSlug, safeTokenEquals, sanitizeLaunchResultForStorage, sanitizedReturnTo, scheduleBackgroundBootstrap, seedActor, seedCreatesMissingTeams, seedExistingTeamIds, selectDispatchTarget, sendAuthEmail, sendEmailConfirmation, sendTeamInviteEmail, sendWelcomeEmail, serializeFrontmatter, serializeUserEmailAddress, setPrimaryEmailAddress, sharedSdk, shouldBypassAcceptanceAuthEmailDelivery, shouldExposeNonProductionAuthDiagnostics, shouldLogApiRequests, signEditorialPreviewToken, signOperationToken, slugifyContent, slugifyRepositoryContent, sourceFromProjectDetails, store, stripeAccountMissingError, stripeAccountToConnectedAccountPatch, stripeClientSecret, stripeCommerceUrl, stripeConfiguredError, stripeConnectService, stripeMetadataValue, stripePriceTermsDrift, stripeRefundStatus, stripeTimestampToIso, stripeVendorApprovalError, subscriptionClientSecret, subscriptionStatusFromStripe, syncCommerceOfferStripeProduct, syncCommercePriceStripePrice, syncCommerceSubscriptionFromStripe, syncPrimaryEmailCaches, teamInviteAcceptUrlFor, timingSafeEqual, trimmedHeaderValue, uiRuntimeLocals, uniqueCloudflareKvNamespaceReferences, uniqueRelationArray, unknownKeys, unwrapLaunchOperationOutput, unwrapOperationPayload, updateCheckoutCompletionFromGroup, updateLaunchDeployments, validateCiRefForEnvironment, validateFeedbackAccess, validateMarketPassword, validateProjectSlug, validatePublicUsername, validateTeamHostCredentialPayload, verifiedEmailCount, verifyCloudflareDnsWriteForLaunch, verifyGitHubOidcToken, verifyMarketPassword, verifyOperationToken, verifyProviderIdToken, webAuthPayload, webSessionData, writeFile, writeLocalContentRecord, writeParsedLocalContentRecord, yamlLines, yamlScalar } = context;
	const { queueProjectHostOperation } = context;
	app.post('/v1/projects/:projectId/hosts/audit', (c) => queueProjectHostOperation(c, 'audit'));
	
	app.post('/v1/projects/:projectId/hosts/:requirementKey/replace', (c) => queueProjectHostOperation(c, 'replace'));
	
	app.post('/v1/projects/:projectId/hosts/:requirementKey/resync', (c) => queueProjectHostOperation(c, 'resync'));
	
	app.post('/v1/projects/:projectId/hosts/:requirementKey/rotate', (c) => queueProjectHostOperation(c, 'rotate'));
	
	app.post('/v1/projects/:projectId/repositories/:role/initialize', async (c) => {
					const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:manage:team');
					if (access.response) return access.response;
					const body = await c.req.json().catch(() => ({}));
					const rejectedUnlock = rejectProjectSecretUnlockMaterial(
						c,
						body,
						'Repository initialization does not accept passphrases or credential sessions. Configure repository credentials through approved host settings before retrying.',
					);
					if (rejectedUnlock) return rejectedUnlock;
					const plaintextCredentials = rejectPlaintextHostCredentialFields(c, body);
					if (plaintextCredentials) return plaintextCredentials;
					const role = optionalTrimmedString(c.req.param('role')) ?? 'primary';
					const repository = resolvePlatformRepositoryDescriptor(runtime.resolved.config, access.details, {
						...body,
						repository: {
							...(body.repository && typeof body.repository === 'object' && !Array.isArray(body.repository) ? body.repository : {}),
							role,
							writeMode: body.execute === true ? 'branch' : 'workspace',
							branchName: optionalTrimmedString(body.branchName) ?? `treeseed/init-${role}-${Date.now()}`,
							push: body.push === true,
						},
					});
					const operation = await store.createPlatformOperation({
						namespace: 'repository',
						operation: 'initialize_linked_repository',
						target: 'market_operations_runner',
						idempotencyKey: optionalTrimmedString(body.idempotencyKey) ?? `repository-init:${access.details.project.id}:${role}`,
						requestedByType: isTeamApiPrincipal(access.principal) ? 'team_api_key' : c.get('actorType') === 'service' ? 'service' : 'user',
						requestedById: access.principal.id,
						input: {
							projectId: access.details.project.id,
							teamId: access.details.project.teamId,
							createdBy: access.principal.id,
							repositoryRole: role,
							repository,
							architecture: access.details.project.metadata?.architecture ?? null,
							scaffoldFiles: Array.isArray(body.scaffoldFiles) ? body.scaffoldFiles : [],
							commitMessage: optionalTrimmedString(body.commitMessage) ?? `Initialize ${access.details.project.name} ${role} repository`,
							approvalRequired: true,
							approvalSatisfied: true,
							approvalId: `repository-init:${access.details.project.id}:${role}:${Date.now()}`,
						},
					});
					await store.appendPlatformOperationEvent(operation.id, 'repository.initialize_queued', {
						projectId: access.details.project.id,
						repositoryRole: role,
					}).catch(() => {});
					return c.json({
						ok: true,
						operation: decoratePlatformOperation(runtime.resolved.config.baseUrl, operation),
					}, { status: 202 });
				});
	
	app.put('/v1/projects/:projectId', async (c) => {
					const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:manage:team');
					if (access.response) return access.response;
					const body = await c.req.json().catch(() => ({}));
					const slugResult = body.slug == null ? { ok: true, slug: access.details.project.slug } : validateProjectSlug(body.slug);
					if (!slugResult.ok) return jsonError(c, 400, slugResult.message, { code: slugResult.code });
					const name = String(body.name ?? access.details.project.name).trim();
					if (!name) return jsonError(c, 400, 'Project name is required.', { code: 'missing_name' });
					const existing = slugResult.slug === access.details.project.slug
						? null
						: await store.getProjectByTeamAndSlug(access.details.project.teamId, slugResult.slug);
					if (existing && existing.id !== c.req.param('projectId')) {
						return jsonError(c, 409, 'That project slug is already in use for this team.', { code: 'slug_taken' });
					}
					const metadataInput = body.metadata && typeof body.metadata === 'object' ? body.metadata : {};
					const requestedCoreObjective = typeof body.coreObjective === 'string'
						? body.coreObjective.trim()
						: typeof metadataInput.coreObjective === 'string'
							? metadataInput.coreObjective.trim()
							: null;
					const existingCoreObjective = typeof access.details.project.metadata?.coreObjective === 'string'
						? access.details.project.metadata.coreObjective.trim()
						: String(access.details.project.description ?? '').trim();
					const shouldSyncCoreObjective = requestedCoreObjective != null && requestedCoreObjective !== existingCoreObjective;
					let coreObjectiveRepository = null;
					let coreObjectiveNormalized = null;
					let coreObjectivePayload = null;
					if (shouldSyncCoreObjective) {
						coreObjectivePayload = {
							title: 'Core Objective',
							slug: 'core',
							overwrite: true,
							preserveFrontmatter: true,
							summary: 'The enduring project objective used as shared planning context.',
							description: 'The enduring project objective used as shared planning context.',
							body: requestedCoreObjective,
							status: 'live',
							timeHorizon: 'long-term',
							motivation: 'Maintained from project settings.',
							repository: {
								...(body.repository && typeof body.repository === 'object' && !Array.isArray(body.repository) ? body.repository : {}),
								role: 'content',
								writeMode: 'branch',
								branchName: `treeseed/core-objective-${Date.now()}`,
								push: true,
							},
						};
						coreObjectiveRepository = resolvePlatformRepositoryDescriptor(runtime.resolved.config, access.details, coreObjectivePayload);
						coreObjectiveNormalized = normalizeRepositoryContentInput('objectives', {
							...coreObjectivePayload,
							projectId: access.details.project.id,
							teamId: access.details.project.teamId,
							createdBy: access.principal.id,
						});
						if (coreObjectiveNormalized.error) return jsonError(c, 400, coreObjectiveNormalized.error);
					}
					const description = typeof body.description === 'string'
						? body.description.trim() || null
						: requestedCoreObjective != null
							? markdownToPlainProjectSummary(requestedCoreObjective, null)
							: access.details.project.description ?? null;
					const updated = await store.updateProject(c.req.param('projectId'), {
						slug: slugResult.slug,
						name,
						description,
						metadata: {
							...(access.details.project.metadata ?? {}),
							...metadataInput,
							...(requestedCoreObjective != null ? { coreObjective: requestedCoreObjective } : {}),
						},
					});
					let coreObjectiveJob = null;
					if (shouldSyncCoreObjective && coreObjectiveRepository && coreObjectiveNormalized && coreObjectivePayload) {
						const approvalId = `project-settings:${updated.id}:core-objective:${Date.now()}`;
						coreObjectiveJob = await store.createPlatformOperation({
							namespace: 'repository',
							operation: 'write_content_record',
							target: 'market_operations_runner',
							idempotencyKey: `project-settings:${updated.id}:core-objective:${updated.updatedAt ?? Date.now()}`,
							requestedByType: isTeamApiPrincipal(access.principal) ? 'team_api_key' : c.get('actorType') === 'service' ? 'service' : 'user',
							requestedById: access.principal.id,
							input: {
								projectId: updated.id,
								teamId: access.details.project.teamId,
								createdBy: access.principal.id,
								repositoryRole: 'content',
								repository: coreObjectiveRepository,
								collection: 'objectives',
								normalized: coreObjectiveNormalized,
								payload: coreObjectivePayload,
								commitMessage: `Update ${updated.name} core objective`,
								approvalRequired: true,
								approvalSatisfied: true,
								approvalId,
							},
						});
						await store.appendPlatformOperationEvent(coreObjectiveJob.id, 'project_settings.core_objective_sync_queued', {
							projectId: updated.id,
							collection: 'objectives',
							slug: 'core',
						}).catch(() => {});
					}
					return c.json({
						ok: true,
						payload: await store.getProjectDetails(updated.id),
						coreObjectiveJob: coreObjectiveJob ? decoratePlatformOperation(runtime.resolved.config.baseUrl, coreObjectiveJob) : null,
					});
				});
	
	app.get('/v1/projects/:projectId/deletion-blockers', async (c) => {
					const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:manage:team');
					if (access.response) return access.response;
					return c.json({ ok: true, payload: await capacity.evaluateProjectDeletionBlockers(c.req.param('projectId')) });
				});
	
	app.delete('/v1/projects/:projectId', async (c) => {
					const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:manage:team');
					if (access.response) return access.response;
					const body = await c.req.json().catch(() => ({}));
					const rejectedUnlock = rejectProjectSecretUnlockMaterial(
						c,
						body,
						'Project deletion no longer accepts passphrases or credential sessions. Re-enter or migrate team-owned secrets into approved targets before deleting connected infrastructure.',
					);
					if (rejectedUnlock) return rejectedUnlock;
					const project = await store.getProject(c.req.param('projectId'));
					if (!project) return jsonError(c, 404, 'Project not found.');
					if (!projectDeletionConfirmationMatches(body.confirmation, project)) {
						return jsonError(c, 400, `Type DELETE ${project.slug} to confirm.`, { code: 'confirmation' });
					}
					const blockers = projectDeletionBlockerRows(await capacity.evaluateProjectDeletionBlockers(project.id));
					if (blockers.length > 0) {
						return jsonError(c, 409, 'Project still has active work that must finish before deletion.', {
							code: 'blocked',
							blockers,
						});
					}
					const details = await store.getProjectDetails(project.id);
					const repositoryHosts = await Promise.all((details?.repositories ?? [])
						.map((repository) => repository.repositoryHostId ? store.getRepositoryHost(project.teamId, repository.repositoryHostId).catch(() => null) : null));
					const hasTeamRepositoryHost = repositoryHosts.some((host) => host?.ownership === 'team_owned');
					const webHostRef = project.metadata?.cloudflareHost ?? details?.hosting?.metadata?.cloudflareHost ?? {};
					const hasTeamWebHost = webHostRef?.mode === 'team_owned' && webHostRef?.hostId;
					if (hasTeamRepositoryHost || hasTeamWebHost) {
						return jsonError(c, 400, 'Project deletion cannot unlock team-owned connected hosts in the API. Re-enter or migrate the selected secrets through CLI/Admin client-side flows before deleting infrastructure.', {
							code: 'sensitive_passphrase_rejected',
						});
					}
					const existingDeletion = (await store.listProjectDeployments(project.id, { action: 'delete_project', limit: 10 }).catch(() => []))
						.find((deployment) => ['queued', 'running'].includes(deployment.status));
					if (existingDeletion) {
						return c.json({
							ok: true,
							payload: existingDeletion,
							deploymentHref: `/app/projects/deployment/${existingDeletion.id}`,
						}, { status: 202 });
					}
					const job = await store.createJob({
						projectId: project.id,
						namespace: 'workflow',
						operation: 'delete_project',
						status: 'running',
						preferredMode: 'auto',
						selectedTarget: 'api',
						input: {
							teamId: project.teamId,
							projectId: project.id,
							projectSlug: project.slug,
							deleteInfrastructure: true,
							deleteData: true,
						},
						requestedByType: 'user',
						requestedById: access.principal?.id ?? null,
					});
					const deployment = await store.createProjectDeployment(project.id, {
						teamId: project.teamId,
						environment: 'prod',
						deploymentKind: 'mixed',
						action: 'delete_project',
						status: 'running',
						platformOperationId: job.id,
						requestedByUserId: access.principal?.id ?? null,
						triggeredByType: 'user',
						triggeredById: access.principal?.id ?? null,
						summary: 'Project infrastructure deletion started.',
						repository: {
							provider: 'github',
							repositories: (details?.repositories ?? []).map((repository) => ({
								role: repository.role,
								owner: repository.owner,
								name: repository.name,
								create: repository.metadata?.create === true,
							})),
						},
						target: {
							provider: 'cloudflare',
							hostMode: webHostRef?.mode ?? null,
							hostId: webHostRef?.hostId ?? null,
						},
						metadata: {
							deletionPhase: 'queued',
							deleteInfrastructure: true,
							deleteData: true,
						},
					});
					await store.updateProject(project.id, {
						metadata: {
							...(project.metadata ?? {}),
							deletion: {
								status: 'running',
								jobId: job.id,
								deploymentId: deployment.id,
								requestedAt: new Date().toISOString(),
								requestedByUserId: access.principal?.id ?? null,
							},
						},
					});
					scheduleBackgroundBootstrap(c, () => runProjectDeletionApiDestroy({
						store,
						projectId: project.id,
						jobId: job.id,
						passphrase: null,
					}));
					return c.json({
						ok: true,
						payload: deployment,
						job,
						deploymentHref: `/app/projects/deployment/${deployment.id}`,
					}, { status: 202 });
				});
	
	app.get('/v1/projects/:projectId/access', async (c) => {
					const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:read:team');
					if (access.response) return access.response;
					return c.json({
						ok: true,
						payload: await store.getProjectAccessSummary(c.req.param('projectId'), access.principal),
					});
				});
	
	app.post('/v1/projects/:projectId/private-knowledge/access', async (c) => {
					const projectId = c.req.param('projectId');
					const body = await c.req.json().catch(() => ({}));
					const principal = c.get('principal');
					if (!principal) {
						return jsonError(c, 401, 'Authentication required.');
					}
					const details = await store.getProjectDetails(projectId);
					if (!details?.project) {
						await recordPrivateKnowledgeAudit(store, {
							eventType: 'private_knowledge.not_found',
							actorId: principal.id,
							projectId,
							body,
							status: 'not_found',
							summary: 'Private knowledge project was not found.',
						});
						return jsonError(c, 404, 'Private knowledge page not found.');
					}
					const teamContext = await store.resolvePrincipalTeamContext(details.project.teamId, principal);
					const allowed = Boolean(teamContext) && (!isTeamApiPrincipal(principal) || principalHasPermission(principal, 'projects:read:team'));
					if (!allowed) {
						await recordPrivateKnowledgeAudit(store, {
							eventType: 'private_knowledge.denied',
							actorId: principal.id,
							projectId: details.project.id,
							body,
							status: 'denied',
							summary: 'Private knowledge access was denied.',
						});
						return jsonError(c, 403, 'Permission denied.');
					}
					const outcome = typeof body.outcome === 'string' ? body.outcome : 'validate';
					if (outcome === 'read' || outcome === 'not_found') {
						await recordPrivateKnowledgeAudit(store, {
							eventType: outcome === 'read' ? 'private_knowledge.read' : 'private_knowledge.not_found',
							actorId: principal.id,
							projectId: details.project.id,
							body,
							status: outcome,
							summary: outcome === 'read' ? 'Private knowledge page was read.' : 'Private knowledge page was not found.',
						});
					}
					return c.json({
						ok: true,
						payload: {
							project: {
								id: details.project.id,
								teamId: details.project.teamId,
								name: details.project.name ?? details.project.slug ?? details.project.id,
								slug: details.project.slug ?? details.project.id,
							},
							team: {
								teamId: details.project.teamId,
								roles: teamContext.roles,
							},
							slug: safePrivateKnowledgeSlug(body.slug),
						},
					});
				});
	
	app.get('/v1/projects/:projectId/summary', async (c) => {
					const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:read:team');
					if (access.response) return access.response;
					return c.json({
						ok: true,
						payload: await store.getProjectSummary(c.req.param('projectId'), access.principal),
					});
				});
	
	app.get('/v1/projects/:projectId/direct', async (c) => {
					const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:read:team');
					if (access.response) return access.response;
					return c.json({
						ok: true,
						payload: await store.getProjectDirectSummary(c.req.param('projectId'), access.principal),
					});
				});
	
	app.get('/v1/projects/:projectId/workstreams', async (c) => {
					const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:read:team');
					if (access.response) return access.response;
					return c.json({
						ok: true,
						payload: await store.getProjectWorkstreamsSummary(c.req.param('projectId'), access.principal),
					});
				});
	
	app.get('/v1/projects/:projectId/releases', async (c) => {
					const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:read:team');
					if (access.response) return access.response;
					return c.json({
						ok: true,
						payload: await store.getProjectReleasesSummary(c.req.param('projectId'), access.principal),
					});
				});
	
	app.get('/v1/projects/:projectId/share', async (c) => {
					const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:read:team');
					if (access.response) return access.response;
					return c.json({
						ok: true,
						payload: await store.getProjectShareSummary(c.req.param('projectId'), access.principal),
					});
				});
}
