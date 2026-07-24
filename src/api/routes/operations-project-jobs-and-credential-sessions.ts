export function installOperationsProjectJobsAndCredentialSessionsRoutes(context: any) {
	const { AGENT_PROMOTION_APPROVAL_DECISIONS, AGENT_TASK_SIGNATURES, AUTH_PROVIDERS, AgentSdk, CHECKOUT_COMMERCIAL_OFFER_MODES, CHECKOUT_OFFER_MODES, CHECKOUT_SUBSCRIPTION_OFFER_MODES, DatabaseAuthProvider, FEEDBACK_SCREENSHOT_TYPES, FEEDBACK_TYPES, GITHUB_ACTIONS_OIDC_ISSUER, HOST_KIND_SESSION_KEYS, LOCAL_CONTENT_COLLECTIONS, LOCAL_CONTENT_DEFAULTS, LOCAL_DECISION_TYPE_VALUES, LOCAL_WORK_CONTENT_COLLECTIONS, MARKET_EMAIL_CONFIRMATION_PREFIX, MAX_FEEDBACK_MESSAGE_LENGTH, MAX_FEEDBACK_SCREENSHOT_BYTES, MarketControlPlaneStore, NOTIFICATION_CONTENT_CAPABILITIES, PERSONAL_THEME_COMPILER_VERSION, PLAINTEXT_HOST_CREDENTIAL_FIELD_NAMES, PLATFORM_OPERATION_SCOPES, POSTGRES_AUTH_PROVIDER_ID, PROPOSAL_VERDICT_DECISION_TYPES, RemoteTreeseedClient, RemoteTreeseedOperationsClient, RemoteTreeseedSdkClient, SENSITIVE_QUERY_PARAM_PATTERN, STRIPE_PRICE_MIRROR_OFFER_MODES, STRIPE_PRODUCT_MIRROR_OFFER_MODES, TreeseedOperationsSdk, accountDeletionBlockers, accountDeletionConfirmationMatches, addRelationValue, apiDatabaseUrl, app, appendLaunchDeploymentEvent, appendLaunchPhaseProjection, appendProjectDeletionProgress, applyCommerceRefundState, applyContentPublishResult, applyHubLaunchFailure, applyHubLaunchResult, applySeedWithStore, artifactDownloadPayload, authConfig, authEmailDeliveryFailureDetail, authEmailDeliveryFailureReason, authProviderId, authTokenTimestampMillis, authTokenTimestampSeconds, availabilityAttempts, availabilityRateLimit, backfillUserEmailAddresses, base64Url, base64urlJson, bearerTokenFromRequest, buildCommerceCheckoutMetadata, buildCommerceStripeMetadata, buildGovernanceApprovalProjection, buildGovernanceProjection, buildInfrastructureProjection, buildKnowledgeArtifactProjection, buildKnowledgeProjection, buildLaunchCredentialOverlay, buildWorkdayProjection, canSkipCloudflareCleanupAfterFailedLaunch, canonicalArchitectureTopology, capacity, centralMarketProfile, checkoutGroupKey, checkoutGroupKind, checkoutGroupStatus, ciOperationForAction, cleanFeedbackString, cloudflareDeletionAuthenticationMessage, cloudflareDnsDomainsForHostValidation, cloudflareErrorMessage, cloudflareProjectDeletionResourceNames, cloudflareRequestForLaunchPreflight, cloudflareRequestForProjectDeletion, collectHostingAuditCredentialOverlay, commerceCheckoutError, commerceErrorResponse, commerceStripeLookupKey, commerceStripePriceParams, commerceStripeProductParams, commerceStripeSyncContext, config, configuredAuthProviderId, confirmationUrlFor, consumeReauthentication, contentRelationPolicy, createApiApp, createApiExtension, createCapacityControlPlane, createCipheriv, createClientEncryptedEscrowService, createCommerceCheckoutRun, createCommerceCheckoutRunForServiceContract, createDecipheriv, createDecisionFromProposals, createGitHubActionsSecretEnclave, createGitHubAppAdapter, createHash, createHmac, createMarketEmailConfirmation, createMarketPostgresDatabase, createMarketWebSession, createOrResendUserEmailAddress, createProjectHostCredentialSessions, createProjectInternalClient, createPublicKey, createRelatedLocalContentRecord, createStripeConnectService, createTreeDxCredentialBridge, createTreeseedApiApp, createVerify, credentialSessionKey, credentialSessionSecret, db, decodeRouteParam, decorateJob, decoratePlatformOperation, decryptCredentialSessionPayload, decryptHostConfig, decryptTeamHostForLaunch, decryptedHostConfigSummary, defaultConfig, deleteCloudflareDnsRecordsForProject, deleteCloudflareProjectResources, deleteTeamCapacityAggregate, derivePlatformOperationNavigation, deriveProjectHostBindingsView, domainInZone, encryptCredentialSessionPayload, encryptedHostPayloadLooksValid, enqueueTreeDxProvisionOperation, ensureCommerceStripeCustomer, ensureMarketCredentialSchema, ensurePrincipal, entitlementRenewalStateFromSubscription, enumValue, exchangeProviderIdentity, executeInline, executeProjectApi, executeSdkOperation, existsSync, exportSeedWithStore, exposeAuthTokenForTests, fallbackRemoteCapability, findById, findDispatchCapability, getSiteAuthConfig, getUserEmailAddress, githubOidcJwksCache, githubRequestForProjectDeletion, grantCommerceEntitlementsForOrder, handleCommerceInvoiceWebhook, handleCommercePaymentIntentWebhook, handleCommerceSubscriptionWebhook, hasRecordedCloudflareRuntimeResources, hashMarketPassword, hostBindingRequiresUnlock, hostKindForBinding, hubRepositoryPolicies, inferZoneNameForDomain, installApiRequestLogger, installCapacityRoutes, installProjectDeploymentRoutes, isLocalAcceptanceServicePrincipal, isLoopbackUrl, isPlatformOperationTerminal, isTeamApiPrincipal, isValidPersonalThemeDraft, jsonError, jsonThrownError, launchCapabilityPreset, launchPlannerRepositoryTopology, listCloudflareNamedResources, listTreeseedManagedHostsFromConfig, listUserEmailAddresses, loadGitHubOidcJwks, loadInfrastructureSeedState, loadKnowledgeContentEntries, loadNotificationPreferences, loadProjectHostBindingContext, loadTemplateCatalog, localAcceptanceAdminToken, localAcceptanceAuthEnabled, localContentPath, localContentRoot, logRequests, managedCloudflareConfigMissing, markdownToPlainProjectSummary, marketAuthContext, marketEmailTokenHash, marketProfilesForTeams, mergeCapability, mergeStringConfig, mkdir, nonSecretLaunchJobInput, normalizeAppearancePreference, normalizeAuditHostKinds, normalizeBaseUrl, normalizeCheckoutQuantity, normalizeCiEnvironment, normalizeDomainName, normalizeEmail, normalizeLocalContentInput, normalizeMarketProfile, normalizeNotificationPreferences, normalizeProjectDomainInput, normalizeProjectLaunchHostBindings, normalizeProviderCredentialConfig, normalizeRelationArray, normalizeRepositoryContentInput, normalizeRepositoryRelationArray, normalizeRepositorySlug, normalizeSeedEnvironments, normalizeTemplateLaunchRequirements, normalizeTreeseedTemplateId, normalizeUsername, normalizedCloudflareKvNamespaceReference, operationTokenSecret, optionalTrimmedString, orderStatusFromPaymentGroup, parseBase64urlJson, parseBooleanEnvValue, parseJsonObject, parseYaml, passwordResetUrlFor, patchLaunchIntentForCredentialOverlay, paymentGroupStatusFromPaymentIntent, pbkdf2Sync, persistProjectHostBindingOperationMetadata, personalThemeFromRow, plaintextHostCredentialFieldPaths, planKnowledgeHubLaunch, planProjectHostBindingOperation, planSeedWithStore, platformOperationMutationError, principalCanManageCommerceProduct, principalHasGlobalPlatformRole, principalHasPermission, principalIsSeedAdmin, privateKnowledgeAuditPayload, processCommerceStripeWebhook, projectAllowedCiRepositories, projectApiConnection, projectAppHref, projectDeletionBlockerRows, projectDeletionConfirmationMatches, projectDeletionHostname, projectDeletionOperation, projectHostBindingMetadata, projectHostResponsePayload, providerConfigFor, providerCredentialValuesForAudit, providerJwksCache, publicPaymentGroups, randomBytes, randomUUID, readCapacityRequestObject, readFile, readJsonOrFormBody, readLocalContentRecord, recordContentNotificationEvent, recordFeedbackSubmission, recordPrivateKnowledgeAudit, redactCommerceOwnershipWorkflow, redactCommerceServiceRequestForBuyer, redactedRequestTarget, refreshCommercePaymentGroupState, refreshCommerceStripeAccount, rejectPlaintextHostCredentialFields, rejectProjectSecretUnlockMaterial, relative, remainingRefundableAmount, repositoryContentRelationPolicy, repositoryInventoryWithPlatform, requestClientIp, requestSessionMetadata, requireCatalogItemAccess, requireCommerceCapacityInquiryAccess, requireCommerceCapacityListingAccess, requireCommerceOfferAccess, requireCommerceProductAccess, requireCommerceVendorForStripe, requireConfiguredServiceCredential, requireConnectedProjectRuntime, requirePlatformRunner, requireProjectAccess, requireProjectRunner, requireSeedApplyAccess, requireSeedPlanAccess, requireSellerTeamAccess, requireServiceBuyerAccess, requireServiceParticipantAccess, requireServiceSellerAccess, requireTeamAccess, requireVendorOrderManager, resolve, resolveAgentArtifactBucket, resolveAgentTaskSignature, resolveApiConfig, resolveAuthApprovalBaseUrl, resolveCloudflareZoneForLaunchPreflight, resolveCommerceCheckoutItem, resolveFulfillmentArtifact, resolveLaunchTemplateRequirements, resolveOrderItemForRefund, resolvePlatformRepositoryDescriptor, resolvePlatformRunnerSecret, resolveProjectDeletionCloudflareZone, resolveProjectLaunchHostBindings, resolvePublicTreeDxTeam, resolveStripeEnvironment, resolveStripePublishableKey, resolveStripeWebhookSecret, resolveTreeseedManagedCloudflareHostConfigFromConfig, resolveUiProjectionContext, resourceRowsFromLaunch, retryApiLaunchBootstrapFromRequest, rm, runProjectDeletionApiDestroy, runProjectLaunchApiBootstrap, runTreeseedHostingAudit, runtime, runtimeMarketAuthProvider, runtimeProviders, safeFeedbackClient, safeFeedbackContext, safeFeedbackScreenshot, safePlatformOperationOutput, safePrivateKnowledgeSlug, safeTokenEquals, sanitizeLaunchResultForStorage, sanitizedReturnTo, scheduleBackgroundBootstrap, seedActor, seedCreatesMissingTeams, seedExistingTeamIds, selectDispatchTarget, sendAuthEmail, sendEmailConfirmation, sendTeamInviteEmail, sendWelcomeEmail, serializeFrontmatter, serializeUserEmailAddress, setPrimaryEmailAddress, sharedSdk, shouldBypassAcceptanceAuthEmailDelivery, shouldExposeNonProductionAuthDiagnostics, shouldLogApiRequests, signEditorialPreviewToken, signOperationToken, slugifyContent, slugifyRepositoryContent, sourceFromProjectDetails, store, stripeAccountMissingError, stripeAccountToConnectedAccountPatch, stripeClientSecret, stripeCommerceUrl, stripeConfiguredError, stripeConnectService, stripeMetadataValue, stripePriceTermsDrift, stripeRefundStatus, stripeTimestampToIso, stripeVendorApprovalError, subscriptionClientSecret, subscriptionStatusFromStripe, syncCommerceOfferStripeProduct, syncCommercePriceStripePrice, syncCommerceSubscriptionFromStripe, syncPrimaryEmailCaches, teamInviteAcceptUrlFor, timingSafeEqual, trimmedHeaderValue, uiRuntimeLocals, uniqueCloudflareKvNamespaceReferences, uniqueRelationArray, unknownKeys, unwrapLaunchOperationOutput, unwrapOperationPayload, updateCheckoutCompletionFromGroup, updateLaunchDeployments, validateCiRefForEnvironment, validateFeedbackAccess, validateMarketPassword, validateProjectSlug, validatePublicUsername, validateTeamHostCredentialPayload, verifiedEmailCount, verifyCloudflareDnsWriteForLaunch, verifyGitHubOidcToken, verifyMarketPassword, verifyOperationToken, verifyProviderIdToken, webAuthPayload, webSessionData, writeFile, writeLocalContentRecord, writeParsedLocalContentRecord, yamlLines, yamlScalar } = context;
	app.get('/v1/jobs/:jobId', async (c) => {
					const auth = await ensurePrincipal(c);
					if (auth.response) return auth.response;
					const job = await store.findJobById(c.req.param('jobId'));
					if (!job) {
						return jsonError(c, 404, `Unknown job "${c.req.param('jobId')}".`);
					}
					const access = await requireProjectAccess(c, store, job.projectId, 'dispatch:execute:team');
					if (access.response) return access.response;
					return c.json({ ok: true, payload: decorateJob(runtime.resolved.config.baseUrl, job) });
				});
	
	app.post('/v1/jobs/:jobId/cancel', async (c) => {
					const auth = await ensurePrincipal(c);
					if (auth.response) return auth.response;
					const job = await store.findJobById(c.req.param('jobId'));
					if (!job) {
						return jsonError(c, 404, `Unknown job "${c.req.param('jobId')}".`);
					}
					const access = await requireProjectAccess(c, store, job.projectId, 'dispatch:execute:team');
					if (access.response) return access.response;
					return c.json({
						ok: true,
						payload: decorateJob(runtime.resolved.config.baseUrl, await store.cancelJob(job.id)),
					});
				});
	
	app.post('/v1/jobs/:jobId/retry', async (c) => {
					const auth = await ensurePrincipal(c);
					if (auth.response) return auth.response;
					const job = await store.findJobById(c.req.param('jobId'));
					if (!job) {
						return jsonError(c, 404, `Unknown job "${c.req.param('jobId')}".`);
					}
					const access = await requireProjectAccess(c, store, job.projectId, 'dispatch:execute:team');
					if (access.response) return access.response;
					if (!['failed', 'cancelled'].includes(job.status)) {
						return jsonError(c, 409, 'Only failed or cancelled jobs can be retried.', { status: job.status });
					}
					const body = await readJsonOrFormBody(c);
					if (job.namespace === 'workflow' && job.operation === 'launch_project' && job.selectedTarget === 'api') {
						const retried = await retryApiLaunchBootstrapFromRequest({
							c,
							store,
							runtime,
							job,
							access,
							body,
							resume: false,
						});
						return retried.response;
					}
					const retried = await store.retryJob(job.id, {
						status: 'pending',
						inputPatch: { resume: false },
						eventType: 'retry_queued',
					});
					if (job.namespace === 'workflow' && job.operation === 'launch_project') {
						const launch = await store.getHubLaunchByJobId(job.id);
						if (launch) {
							await store.updateHubLaunch(launch.id, {
								state: 'queued',
								currentPhase: 'launch_retry_queued',
								error: null,
							});
							await store.appendHubLaunchEvent(launch.id, {
								phase: 'launch_retry_queued',
								status: 'queued',
								title: 'Launch retry queued',
								summary: 'TreeSeed will rerun the launch job.',
								data: { jobId: job.id },
							});
						}
					}
					return c.json({
						ok: true,
						payload: decorateJob(runtime.resolved.config.baseUrl, retried),
					}, { status: 202 });
				});
	
	app.post('/v1/jobs/:jobId/resume', async (c) => {
					const auth = await ensurePrincipal(c);
					if (auth.response) return auth.response;
					const job = await store.findJobById(c.req.param('jobId'));
					if (!job) {
						return jsonError(c, 404, `Unknown job "${c.req.param('jobId')}".`);
					}
					const access = await requireProjectAccess(c, store, job.projectId, 'dispatch:execute:team');
					if (access.response) return access.response;
					if (!['failed', 'cancelled'].includes(job.status)) {
						return jsonError(c, 409, 'Only failed or cancelled jobs can be resumed.', { status: job.status });
					}
					const body = await readJsonOrFormBody(c);
					if (job.namespace === 'workflow' && job.operation === 'launch_project' && job.selectedTarget === 'api') {
						const resumed = await retryApiLaunchBootstrapFromRequest({
							c,
							store,
							runtime,
							job,
							access,
							body,
							resume: true,
						});
						return resumed.response;
					}
					const repositories = await store.listHubRepositories(job.projectId);
					const softwareRepository = repositories.find((repository) => repository.role === 'software') ?? null;
					const contentRepository = repositories.find((repository) => repository.role === 'content') ?? null;
					const existingLaunchIntent = job.input?.launchIntent && typeof job.input.launchIntent === 'object'
						? job.input.launchIntent
						: null;
					const resumedLaunchIntent = existingLaunchIntent
						? {
							...existingLaunchIntent,
							repository: {
								...(existingLaunchIntent.repository ?? {}),
								softwareRepository: softwareRepository
									? {
										owner: softwareRepository.owner,
										name: softwareRepository.name,
										url: softwareRepository.url,
										defaultBranch: softwareRepository.defaultBranch,
									}
									: existingLaunchIntent.repository?.softwareRepository ?? null,
								contentRepository: contentRepository
									? {
										owner: contentRepository.owner,
										name: contentRepository.name,
										url: contentRepository.url,
										defaultBranch: contentRepository.defaultBranch,
									}
									: existingLaunchIntent.repository?.contentRepository ?? null,
							},
						}
						: null;
					const resumed = await store.retryJob(job.id, {
						status: 'pending',
						inputPatch: {
							resume: true,
							...(resumedLaunchIntent ? { launchIntent: resumedLaunchIntent } : {}),
						},
						eventType: 'resume_queued',
					});
					if (job.namespace === 'workflow' && job.operation === 'launch_project') {
						const launch = await store.getHubLaunchByJobId(job.id);
						if (launch) {
							await store.updateHubLaunch(launch.id, {
								state: 'queued',
								currentPhase: 'launch_resume_queued',
								error: null,
							});
							await store.appendHubLaunchEvent(launch.id, {
								phase: 'launch_resume_queued',
								status: 'queued',
								title: 'Launch resume queued',
								summary: 'TreeSeed will resume from the last recorded launch phase when possible.',
								data: {
									jobId: job.id,
									lastSuccessfulPhase: launch.lastSuccessfulPhase ?? null,
								},
							});
						}
					}
					return c.json({
						ok: true,
						payload: decorateJob(runtime.resolved.config.baseUrl, resumed),
					}, { status: 202 });
				});
	
	app.post('/v1/jobs/:jobId/approve', async (c) => {
					const auth = await ensurePrincipal(c);
					if (auth.response) return auth.response;
					const job = await store.findJobById(c.req.param('jobId'));
					if (!job) {
						return jsonError(c, 404, `Unknown job "${c.req.param('jobId')}".`);
					}
					const access = await requireProjectAccess(c, store, job.projectId, 'projects:manage:team');
					if (access.response) return access.response;
					if (c.get('actorType') === 'service') {
						return jsonError(c, 403, 'Service principals cannot approve binding work.');
					}
					if (job.status !== 'waiting_for_approval') {
						return jsonError(c, 409, 'This job is not waiting for approval.', { status: job.status });
					}
					const body = await c.req.json().catch(() => ({}));
					const actionPath = typeof job.input?.actionPath === 'string' ? job.input.actionPath : null;
					if (!actionPath) {
						await store.appendJobEvent(job.id, 'approved', {
							approvedBy: access.principal.id,
							note: typeof body.note === 'string' ? body.note : null,
						});
						const approvedJob = await store.retryJob(job.id, {
							status: 'pending',
							inputPatch: {
								approvalReference: {
									approvedBy: access.principal.id,
									approvedAt: new Date().toISOString(),
									note: typeof body.note === 'string' ? body.note : null,
								},
							},
							eventType: 'approval_released',
						});
						const teamId = typeof job.input?.teamId === 'string' ? job.input.teamId : access.details.project.teamId;
						await store.deleteTeamInboxItemsByItemKey(teamId, job.id);
						return c.json({
							ok: true,
							payload: decorateJob(runtime.resolved.config.baseUrl, approvedJob),
						}, { status: 202 });
					}
					await store.appendJobEvent(job.id, 'approved', {
						approvedBy: access.principal.id,
						note: typeof body.note === 'string' ? body.note : null,
					});
					await store.recordJobProgress(job.id, {
						summary: 'Approval granted. Executing approved action.',
					});
					const delegated = await store.requestProjectRuntime(job.projectId, access.principal, actionPath, {
						method: 'POST',
						body: typeof job.input?.requestBody === 'object' && job.input.requestBody ? job.input.requestBody : {},
					});
					if (!delegated) {
						const failedJob = await store.failJob(job.id, {
							code: 'runtime_unavailable',
							message: 'Project runtime is not connected or unavailable for the approved action.',
						});
						return c.json({
							ok: false,
							payload: decorateJob(runtime.resolved.config.baseUrl, failedJob),
						}, { status: 409 });
					}
					const completed = await store.completeJob(job.id, {
						output: {
							approvedBy: access.principal.id,
							result: delegated,
						},
					});
					const teamId = typeof job.input?.teamId === 'string' ? job.input.teamId : access.details.project.teamId;
					await store.deleteTeamInboxItemsByItemKey(teamId, job.id);
					return c.json({
						ok: true,
						payload: {
							job: decorateJob(runtime.resolved.config.baseUrl, completed),
							result: delegated,
						},
					});
				});
	
	app.post('/v1/jobs/:jobId/reject', async (c) => {
					const auth = await ensurePrincipal(c);
					if (auth.response) return auth.response;
					const job = await store.findJobById(c.req.param('jobId'));
					if (!job) {
						return jsonError(c, 404, `Unknown job "${c.req.param('jobId')}".`);
					}
					const access = await requireProjectAccess(c, store, job.projectId, 'projects:manage:team');
					if (access.response) return access.response;
					if (c.get('actorType') === 'service') {
						return jsonError(c, 403, 'Service principals cannot decide approval requests.');
					}
					if (job.status !== 'waiting_for_approval') {
						return jsonError(c, 409, 'This job is not waiting for approval.', { status: job.status });
					}
					const body = await c.req.json().catch(() => ({}));
					const rejected = await store.failJob(job.id, {
						code: 'approval_rejected',
						message: typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim() : 'Approval rejected.',
					});
					const teamId = typeof job.input?.teamId === 'string' ? job.input.teamId : access.details.project.teamId;
					await store.deleteTeamInboxItemsByItemKey(teamId, job.id);
					return c.json({
						ok: true,
						payload: decorateJob(runtime.resolved.config.baseUrl, rejected),
					});
				});
	
	app.post('/v1/jobs/:jobId/provider-credential-sessions/:sessionId/consume', async (c) => {
					const job = await store.findJobById(c.req.param('jobId'));
					if (!job) {
						return jsonError(c, 404, `Unknown job "${c.req.param('jobId')}".`);
					}
					const runnerAccess = await requireProjectRunner(c, store, job.projectId);
					if (runnerAccess.response) return runnerAccess.response;
					const consumed = await store.consumeProviderCredentialSession(job.id, c.req.param('sessionId'));
					if (!consumed.ok) {
						return jsonError(c, consumed.error === 'expired' ? 410 : 404, consumed.error);
					}
					try {
						const sessionPayload = decryptCredentialSessionPayload(runtime, consumed.payload.encryptedPayload);
						return c.json({
							ok: true,
							payload: {
								id: consumed.payload.id,
								hostKind: consumed.payload.hostKind,
								hostId: consumed.payload.hostId,
								purpose: consumed.payload.purpose,
								provider: sessionPayload.provider ?? null,
								config: sessionPayload.config && typeof sessionPayload.config === 'object' ? sessionPayload.config : {},
							},
						});
					} catch (error) {
						return jsonError(c, 500, 'Unable to decrypt credential session payload.', {
							message: error instanceof Error ? error.message : String(error),
						});
					}
				});
}
