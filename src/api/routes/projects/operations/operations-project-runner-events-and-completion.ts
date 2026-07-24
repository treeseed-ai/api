export function installOperationsProjectRunnerEventsAndCompletionRoutes(context: any) {
	const { AGENT_PROMOTION_APPROVAL_DECISIONS, AGENT_TASK_SIGNATURES, AUTH_PROVIDERS, AgentSdk, CHECKOUT_COMMERCIAL_OFFER_MODES, CHECKOUT_OFFER_MODES, CHECKOUT_SUBSCRIPTION_OFFER_MODES, DatabaseAuthProvider, FEEDBACK_SCREENSHOT_TYPES, FEEDBACK_TYPES, GITHUB_ACTIONS_OIDC_ISSUER, HOST_KIND_SESSION_KEYS, LOCAL_CONTENT_COLLECTIONS, LOCAL_CONTENT_DEFAULTS, LOCAL_DECISION_TYPE_VALUES, LOCAL_WORK_CONTENT_COLLECTIONS, MARKET_EMAIL_CONFIRMATION_PREFIX, MAX_FEEDBACK_MESSAGE_LENGTH, MAX_FEEDBACK_SCREENSHOT_BYTES, MarketControlPlaneStore, NOTIFICATION_CONTENT_CAPABILITIES, PERSONAL_THEME_COMPILER_VERSION, PLAINTEXT_HOST_CREDENTIAL_FIELD_NAMES, PLATFORM_OPERATION_SCOPES, POSTGRES_AUTH_PROVIDER_ID, PROPOSAL_VERDICT_DECISION_TYPES, RemoteClient, RemoteOperationsClient, RemoteSdkClient, SENSITIVE_QUERY_PARAM_PATTERN, STRIPE_PRICE_MIRROR_OFFER_MODES, STRIPE_PRODUCT_MIRROR_OFFER_MODES, OperationsSdk, accountDeletionBlockers, accountDeletionConfirmationMatches, addRelationValue, apiDatabaseUrl, app, appendLaunchDeploymentEvent, appendLaunchPhaseProjection, appendProjectDeletionProgress, applyCommerceRefundState, applyContentPublishResult, applyHubLaunchFailure, applyHubLaunchResult, applySeedWithStore, artifactDownloadPayload, authConfig, authEmailDeliveryFailureDetail, authEmailDeliveryFailureReason, authProviderId, authTokenTimestampMillis, authTokenTimestampSeconds, availabilityAttempts, availabilityRateLimit, backfillUserEmailAddresses, base64Url, base64urlJson, bearerTokenFromRequest, buildCommerceCheckoutMetadata, buildCommerceStripeMetadata, buildGovernanceApprovalProjection, buildGovernanceProjection, buildInfrastructureProjection, buildKnowledgeArtifactProjection, buildKnowledgeProjection, buildLaunchCredentialOverlay, buildWorkdayProjection, canSkipCloudflareCleanupAfterFailedLaunch, canonicalArchitectureTopology, capacity, centralMarketProfile, checkoutGroupKey, checkoutGroupKind, checkoutGroupStatus, ciOperationForAction, cleanFeedbackString, cloudflareDeletionAuthenticationMessage, cloudflareDnsDomainsForHostValidation, cloudflareErrorMessage, cloudflareProjectDeletionResourceNames, cloudflareRequestForLaunchPreflight, cloudflareRequestForProjectDeletion, collectHostingAuditCredentialOverlay, commerceCheckoutError, commerceErrorResponse, commerceStripeLookupKey, commerceStripePriceParams, commerceStripeProductParams, commerceStripeSyncContext, config, configuredAuthProviderId, confirmationUrlFor, consumeReauthentication, contentRelationPolicy, createApiExtension, createCapacityControlPlane, createCipheriv, createClientEncryptedEscrowService, createCommerceCheckoutRun, createCommerceCheckoutRunForServiceContract, createDecipheriv, createDecisionFromProposals, createGitHubActionsSecretEnclave, createGitHubAppAdapter, createHash, createHmac, createMarketEmailConfirmation, createMarketPostgresDatabase, createMarketWebSession, createOrResendUserEmailAddress, createProjectHostCredentialSessions, createProjectInternalClient, createPublicKey, createRelatedLocalContentRecord, createStripeConnectService, createTreeDxCredentialBridge, createVerify, credentialSessionKey, credentialSessionSecret, db, decodeRouteParam, decorateJob, decoratePlatformOperation, decryptCredentialSessionPayload, decryptHostConfig, decryptTeamHostForLaunch, decryptedHostConfigSummary, defaultConfig, deleteCloudflareDnsRecordsForProject, deleteCloudflareProjectResources, deleteTeamCapacityAggregate, derivePlatformOperationNavigation, deriveProjectHostBindingsView, domainInZone, encryptCredentialSessionPayload, encryptedHostPayloadLooksValid, enqueueTreeDxProvisionOperation, ensureCommerceStripeCustomer, ensureMarketCredentialSchema, ensurePrincipal, entitlementRenewalStateFromSubscription, enumValue, exchangeProviderIdentity, executeInline, executeProjectApi, executeSdkOperation, existsSync, exportSeedWithStore, exposeAuthTokenForTests, fallbackRemoteCapability, findById, findDispatchCapability, getSiteAuthConfig, getUserEmailAddress, githubOidcJwksCache, githubRequestForProjectDeletion, grantCommerceEntitlementsForOrder, handleCommerceInvoiceWebhook, handleCommercePaymentIntentWebhook, handleCommerceSubscriptionWebhook, hasRecordedCloudflareRuntimeResources, hashMarketPassword, hostBindingRequiresUnlock, hostKindForBinding, hubRepositoryPolicies, inferZoneNameForDomain, installApiRequestLogger, installCapacityRoutes, installProjectDeploymentRoutes, isLocalAcceptanceServicePrincipal, isLoopbackUrl, isPlatformOperationTerminal, isTeamApiPrincipal, isValidPersonalThemeDraft, jsonError, jsonThrownError, launchCapabilityPreset, launchPlannerRepositoryTopology, listCloudflareNamedResources, listManagedHostsFromConfig, listUserEmailAddresses, loadGitHubOidcJwks, loadInfrastructureSeedState, loadKnowledgeContentEntries, loadNotificationPreferences, loadProjectHostBindingContext, loadTemplateCatalog, localAcceptanceAdminToken, localAcceptanceAuthEnabled, localContentPath, localContentRoot, logRequests, managedCloudflareConfigMissing, markdownToPlainProjectSummary, marketAuthContext, marketEmailTokenHash, marketProfilesForTeams, mergeCapability, mergeStringConfig, mkdir, nonSecretLaunchJobInput, normalizeAppearancePreference, normalizeAuditHostKinds, normalizeBaseUrl, normalizeCheckoutQuantity, normalizeCiEnvironment, normalizeDomainName, normalizeEmail, normalizeLocalContentInput, normalizeMarketProfile, normalizeNotificationPreferences, normalizeProjectDomainInput, normalizeProjectLaunchHostBindings, normalizeProviderCredentialConfig, normalizeRelationArray, normalizeRepositoryContentInput, normalizeRepositoryRelationArray, normalizeRepositorySlug, normalizeSeedEnvironments, normalizeTemplateLaunchRequirements, normalizeTemplateId, normalizeUsername, normalizedCloudflareKvNamespaceReference, operationTokenSecret, optionalTrimmedString, orderStatusFromPaymentGroup, parseBase64urlJson, parseBooleanEnvValue, parseJsonObject, parseYaml, passwordResetUrlFor, patchLaunchIntentForCredentialOverlay, paymentGroupStatusFromPaymentIntent, pbkdf2Sync, persistProjectHostBindingOperationMetadata, personalThemeFromRow, plaintextHostCredentialFieldPaths, planKnowledgeHubLaunch, planProjectHostBindingOperation, planSeedWithStore, platformOperationMutationError, principalCanManageCommerceProduct, principalHasGlobalPlatformRole, principalHasPermission, principalIsSeedAdmin, privateKnowledgeAuditPayload, processCommerceStripeWebhook, projectAllowedCiRepositories, projectApiConnection, projectAppHref, projectDeletionBlockerRows, projectDeletionConfirmationMatches, projectDeletionHostname, projectDeletionOperation, projectHostBindingMetadata, projectHostResponsePayload, providerConfigFor, providerCredentialValuesForAudit, providerJwksCache, publicPaymentGroups, randomBytes, randomUUID, readCapacityRequestObject, readFile, readJsonOrFormBody, readLocalContentRecord, recordContentNotificationEvent, recordFeedbackSubmission, recordPrivateKnowledgeAudit, redactCommerceOwnershipWorkflow, redactCommerceServiceRequestForBuyer, redactedRequestTarget, refreshCommercePaymentGroupState, refreshCommerceStripeAccount, rejectPlaintextHostCredentialFields, rejectProjectSecretUnlockMaterial, relative, remainingRefundableAmount, repositoryContentRelationPolicy, repositoryInventoryWithPlatform, requestClientIp, requestSessionMetadata, requireCatalogItemAccess, requireCommerceCapacityInquiryAccess, requireCommerceCapacityListingAccess, requireCommerceOfferAccess, requireCommerceProductAccess, requireCommerceVendorForStripe, requireConfiguredServiceCredential, requireConnectedProjectRuntime, requirePlatformRunner, requireProjectAccess, requireProjectRunner, requireSeedApplyAccess, requireSeedPlanAccess, requireSellerTeamAccess, requireServiceBuyerAccess, requireServiceParticipantAccess, requireServiceSellerAccess, requireTeamAccess, requireVendorOrderManager, resolve, resolveAgentArtifactBucket, resolveAgentTaskSignature, resolveApiConfig, resolveAuthApprovalBaseUrl, resolveCloudflareZoneForLaunchPreflight, resolveCommerceCheckoutItem, resolveFulfillmentArtifact, resolveLaunchTemplateRequirements, resolveOrderItemForRefund, resolvePlatformRepositoryDescriptor, resolvePlatformRunnerSecret, resolveProjectDeletionCloudflareZone, resolveProjectLaunchHostBindings, resolvePublicTreeDxTeam, resolveStripeEnvironment, resolveStripePublishableKey, resolveStripeWebhookSecret, resolveManagedCloudflareHostConfigFromConfig, resolveUiProjectionContext, resourceRowsFromLaunch, retryApiLaunchBootstrapFromRequest, rm, runProjectDeletionApiDestroy, runProjectLaunchApiBootstrap, runHostingAudit, runtime, runtimeMarketAuthProvider, runtimeProviders, safeFeedbackClient, safeFeedbackContext, safeFeedbackScreenshot, safePlatformOperationOutput, safePrivateKnowledgeSlug, safeTokenEquals, sanitizeLaunchResultForStorage, sanitizedReturnTo, scheduleBackgroundBootstrap, seedActor, seedCreatesMissingTeams, seedExistingTeamIds, selectDispatchTarget, sendAuthEmail, sendEmailConfirmation, sendTeamInviteEmail, sendWelcomeEmail, serializeFrontmatter, serializeUserEmailAddress, setPrimaryEmailAddress, sharedSdk, shouldBypassAcceptanceAuthEmailDelivery, shouldExposeNonProductionAuthDiagnostics, shouldLogApiRequests, signEditorialPreviewToken, signOperationToken, slugifyContent, slugifyRepositoryContent, sourceFromProjectDetails, store, stripeAccountMissingError, stripeAccountToConnectedAccountPatch, stripeClientSecret, stripeCommerceUrl, stripeConfiguredError, stripeConnectService, stripeMetadataValue, stripePriceTermsDrift, stripeRefundStatus, stripeTimestampToIso, stripeVendorApprovalError, subscriptionClientSecret, subscriptionStatusFromStripe, syncCommerceOfferStripeProduct, syncCommercePriceStripePrice, syncCommerceSubscriptionFromStripe, syncPrimaryEmailCaches, teamInviteAcceptUrlFor, timingSafeEqual, trimmedHeaderValue, uiRuntimeLocals, uniqueCloudflareKvNamespaceReferences, uniqueRelationArray, unknownKeys, unwrapLaunchOperationOutput, unwrapOperationPayload, updateCheckoutCompletionFromGroup, updateLaunchDeployments, validateCiRefForEnvironment, validateFeedbackAccess, validateMarketPassword, validateProjectSlug, validatePublicUsername, validateTeamHostCredentialPayload, verifiedEmailCount, verifyCloudflareDnsWriteForLaunch, verifyGitHubOidcToken, verifyMarketPassword, verifyOperationToken, verifyProviderIdToken, webAuthPayload, webSessionData, writeFile, writeLocalContentRecord, writeParsedLocalContentRecord, yamlLines, yamlScalar } = context;
	app.get('/v1/jobs/:jobId/events', async (c) => {
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
						payload: await store.listJobEvents(job.id),
					});
				});
	
	app.post('/v1/projects/:projectId/runner/jobs/pull', async (c) => {
					const token = bearerTokenFromRequest(c.req.raw);
					if (!token) {
						return jsonError(c, 401, 'Authentication required.');
					}
					const runner = await store.authenticateRunner(c.req.param('projectId'), token);
					if (!runner) {
						return jsonError(c, 401, 'Invalid project runner token.');
					}
					const body = await c.req.json().catch(() => ({}));
					const jobs = await store.pullJobsForRunner(c.req.param('projectId'), {
						limit: body.limit,
						runnerId: typeof body.runnerId === 'string' ? body.runnerId : null,
					});
					return c.json({
						ok: true,
						payload: jobs.map((job) => decorateJob(runtime.resolved.config.baseUrl, job)),
					});
				});
	
	app.put('/v1/projects/:projectId/runner/environments/:environment', async (c) => {
					const runnerAccess = await requireProjectRunner(c, store, c.req.param('projectId'));
					if (runnerAccess.response) return runnerAccess.response;
					const body = await c.req.json().catch(() => ({}));
					return c.json({
						ok: true,
						payload: await store.upsertProjectEnvironment(c.req.param('projectId'), {
							environment: c.req.param('environment'),
							deploymentProfile: typeof body.deploymentProfile === 'string' ? body.deploymentProfile : 'self_hosted_project',
							baseUrl: typeof body.baseUrl === 'string' ? body.baseUrl : null,
							cloudflareAccountId: typeof body.cloudflareAccountId === 'string' ? body.cloudflareAccountId : null,
							pagesProjectName: typeof body.pagesProjectName === 'string' ? body.pagesProjectName : null,
							workerName: typeof body.workerName === 'string' ? body.workerName : null,
							r2BucketName: typeof body.r2BucketName === 'string' ? body.r2BucketName : null,
							d1DatabaseName: typeof body.d1DatabaseName === 'string' ? body.d1DatabaseName : null,
							railwayProjectName: typeof body.railwayProjectName === 'string' ? body.railwayProjectName : null,
							metadata: typeof body.metadata === 'object' && body.metadata ? body.metadata : {},
						}),
					});
				});
	
	app.post('/v1/projects/:projectId/runner/resources', async (c) => {
					const runnerAccess = await requireProjectRunner(c, store, c.req.param('projectId'));
					if (runnerAccess.response) return runnerAccess.response;
					const body = await c.req.json().catch(() => ({}));
					if (!body.environment || !body.provider || !body.resourceKind || !body.logicalName) {
						return jsonError(c, 400, 'environment, provider, resourceKind, and logicalName are required.');
					}
					return c.json({
						ok: true,
						payload: await store.upsertProjectInfrastructureResource(c.req.param('projectId'), {
							environment: String(body.environment),
							provider: String(body.provider),
							resourceKind: String(body.resourceKind),
							logicalName: String(body.logicalName),
							locator: typeof body.locator === 'string' ? body.locator : null,
							metadata: typeof body.metadata === 'object' && body.metadata ? body.metadata : {},
						}),
					});
				});
	
	app.post('/v1/projects/:projectId/runner/deployments', async (c) => {
					const runnerAccess = await requireProjectRunner(c, store, c.req.param('projectId'));
					if (runnerAccess.response) return runnerAccess.response;
					const body = await c.req.json().catch(() => ({}));
					if (!body.environment || !body.deploymentKind) {
						return jsonError(c, 400, 'environment and deploymentKind are required.');
					}
					return c.json({
						ok: true,
						payload: await store.createProjectDeployment(c.req.param('projectId'), {
							environment: String(body.environment),
							deploymentKind: String(body.deploymentKind),
							status: typeof body.status === 'string' ? body.status : 'pending',
							sourceRef: typeof body.sourceRef === 'string' ? body.sourceRef : null,
							releaseTag: typeof body.releaseTag === 'string' ? body.releaseTag : null,
							commitSha: typeof body.commitSha === 'string' ? body.commitSha : null,
							triggeredByType: typeof body.triggeredByType === 'string' ? body.triggeredByType : 'project_runner',
							triggeredById: typeof body.triggeredById === 'string' ? body.triggeredById : runnerAccess.runner.tokenDigest,
							metadata: typeof body.metadata === 'object' && body.metadata ? body.metadata : {},
							startedAt: typeof body.startedAt === 'string' ? body.startedAt : null,
							finishedAt: typeof body.finishedAt === 'string' ? body.finishedAt : null,
						}),
					});
				});
	
	app.get('/v1/projects/:projectId/runner/deployments', async (c) => {
					const runnerAccess = await requireProjectRunner(c, store, c.req.param('projectId'));
					if (runnerAccess.response) return runnerAccess.response;
					const environment = typeof c.req.query('environment') === 'string' ? c.req.query('environment') : null;
					return c.json({
						ok: true,
						payload: await store.listProjectDeployments(c.req.param('projectId'), environment),
					});
				});
	
	app.get('/v1/projects/:projectId/runner/health', async (c) => {
					const runnerAccess = await requireProjectRunner(c, store, c.req.param('projectId'));
					if (runnerAccess.response) return runnerAccess.response;
					const environment = typeof c.req.query('environment') === 'string' ? c.req.query('environment') : 'staging';
					const [resources, deployments, workdays] = await Promise.all([
						store.listProjectInfrastructureResources(c.req.param('projectId'), environment),
						store.listProjectDeployments(c.req.param('projectId'), environment),
						capacity.listWorkdayCapacityEnvelopes(c.req.param('projectId')),
					]);
					return c.json({
						ok: true,
						payload: {
							environment,
							resources,
							deployments: deployments.slice(0, 10),
							workdays: workdays.slice(0, 5),
						},
					});
				});
	
	app.post('/v1/projects/:projectId/runner/artifacts', async (c) => {
					const runnerAccess = await requireProjectRunner(c, store, c.req.param('projectId'));
					if (runnerAccess.response) return runnerAccess.response;
					const body = await c.req.json().catch(() => ({}));
					if (!body.objectKey) return jsonError(c, 400, 'objectKey is required.');
					const payload = await store.uploadRuntimeArtifact(c.req.param('projectId'), {
						objectKey: String(body.objectKey),
						content: typeof body.content === 'string' || (body.content && typeof body.content === 'object') ? body.content : null,
						contentBase64: typeof body.contentBase64 === 'string' ? body.contentBase64 : null,
						contentType: typeof body.contentType === 'string' ? body.contentType : null,
					});
					return payload ? c.json({ ok: true, payload }, { status: 201 }) : jsonError(c, 400, 'Invalid artifact upload.');
				});
	
	app.post('/v1/projects/:projectId/runner/approval-requests', async (c) => {
					const runnerAccess = await requireProjectRunner(c, store, c.req.param('projectId'));
					if (runnerAccess.response) return runnerAccess.response;
					const project = await store.getProject(c.req.param('projectId'));
					if (!project) return jsonError(c, 404, 'Unknown project.');
					const body = await c.req.json().catch(() => ({}));
					if (!body.kind || !body.title || !body.summary) {
						return jsonError(c, 400, 'kind, title, and summary are required.');
					}
					const request = await store.createApprovalRequest({
						...body,
						teamId: typeof body.teamId === 'string' ? body.teamId : project.teamId,
						projectId: c.req.param('projectId'),
						requestedByType: typeof body.requestedByType === 'string' ? body.requestedByType : 'worker',
					});
					await store.upsertTeamInboxItem(request.teamId, {
						id: `approval-request:${request.id}`,
						projectId: request.projectId,
						kind: 'approval',
						state: 'waiting_for_approval',
						title: request.title,
						summary: request.summary,
						href: await projectAppHref(store, request.teamId, project.slug, 'workdays'),
						itemKey: request.id,
						metadata: {
							approvalRequestId: request.id,
							approvalKind: request.kind,
							workDayId: request.workDayId,
							taskId: request.taskId,
						},
					});
					return c.json({ ok: true, payload: request }, { status: 201 });
				});
	
	app.post('/v1/jobs/:jobId/progress', async (c) => {
					const token = bearerTokenFromRequest(c.req.raw);
					if (!token) {
						return jsonError(c, 401, 'Authentication required.');
					}
					const job = await store.findJobById(c.req.param('jobId'));
					if (!job) {
						return jsonError(c, 404, `Unknown job "${c.req.param('jobId')}".`);
					}
					const runner = await store.authenticateRunner(job.projectId, token);
					if (!runner) {
						return jsonError(c, 401, 'Invalid project runner token.');
					}
					const body = await c.req.json().catch(() => ({}));
					if (job.namespace === 'workflow' && job.operation === 'launch_project' && body.data && typeof body.data === 'object' && typeof body.data.phase === 'string') {
						const launch = await store.getHubLaunchByJobId(job.id);
						if (launch) {
							await appendLaunchPhaseProjection(store, launch.id, job.id, {
								...body.data,
								phase: body.data.phase,
								status: typeof body.data.status === 'string' ? body.data.status : 'running',
								title: typeof body.data.title === 'string' ? body.data.title : String(body.data.phase).replace(/_/gu, ' '),
								summary: typeof body.summary === 'string' ? body.summary : typeof body.data.summary === 'string' ? body.data.summary : null,
								data: body.data,
							});
						}
					}
					return c.json({
						ok: true,
						payload: decorateJob(runtime.resolved.config.baseUrl, await store.recordJobProgress(job.id, {
							summary: typeof body.summary === 'string' ? body.summary : null,
							data: typeof body.data === 'object' && body.data ? body.data : {},
						})),
					});
				});
	
	app.post('/v1/jobs/:jobId/complete', async (c) => {
					const token = bearerTokenFromRequest(c.req.raw);
					if (!token) {
						return jsonError(c, 401, 'Authentication required.');
					}
					const job = await store.findJobById(c.req.param('jobId'));
					if (!job) {
						return jsonError(c, 404, `Unknown job "${c.req.param('jobId')}".`);
					}
					const runner = await store.authenticateRunner(job.projectId, token);
					if (!runner) {
						return jsonError(c, 401, 'Invalid project runner token.');
					}
					const body = await c.req.json().catch(() => ({}));
					if (job.namespace === 'workflow' && job.operation === 'launch_project') {
						await applyHubLaunchResult(store, runtime, job, body.output, runner);
					}
					if (job.namespace === 'content' && job.operation === 'publish') {
						await applyContentPublishResult(store, job, body.output);
						for (const event of Array.isArray(body.output?.notificationEvents) ? body.output.notificationEvents : []) {
							await recordContentNotificationEvent(store, {
								idempotencyKey: String(event.idempotencyKey ?? `${job.id}:${event.contentType}:${event.resourceId}`),
								eventType: String(event.eventType ?? ''),
								contentType: String(event.contentType ?? ''),
								projectId: job.projectId,
								actorId: typeof event.actorId === 'string' ? event.actorId : null,
								resourceId: String(event.resourceId ?? ''),
								title: String(event.title ?? ''),
								summary: typeof event.summary === 'string' ? event.summary : null,
								targetUrl: String(event.targetUrl ?? ''),
							});
						}
						const project = await store.getProject(job.projectId);
						if (project) {
							await store.deleteTeamInboxItemsByItemKey(project.teamId, job.id);
						}
					}
					return c.json({
						ok: true,
						payload: decorateJob(runtime.resolved.config.baseUrl, await store.completeJob(job.id, {
							output: body.output,
						})),
					});
				});
	
	app.post('/v1/jobs/:jobId/fail', async (c) => {
					const token = bearerTokenFromRequest(c.req.raw);
					if (!token) {
						return jsonError(c, 401, 'Authentication required.');
					}
					const job = await store.findJobById(c.req.param('jobId'));
					if (!job) {
						return jsonError(c, 404, `Unknown job "${c.req.param('jobId')}".`);
					}
					const runner = await store.authenticateRunner(job.projectId, token);
					if (!runner) {
						return jsonError(c, 401, 'Invalid project runner token.');
					}
					const body = await c.req.json().catch(() => ({}));
					if (!body.message) {
						return jsonError(c, 400, 'message is required.');
					}
					if (job.namespace === 'workflow' && job.operation === 'launch_project') {
						await applyHubLaunchFailure(store, job, {
							code: typeof body.code === 'string' ? body.code : null,
							message: String(body.message),
						});
					}
					if (job.namespace === 'content' && job.operation === 'publish') {
						const project = await store.getProject(job.projectId);
						if (project) {
							await store.upsertTeamInboxItem(project.teamId, {
								id: `content-publish-failure:${job.id}`,
								projectId: project.id,
								kind: 'content_publish_failure',
								state: 'open',
								title: `${project.name}: content publish failed`,
								summary: String(body.message),
								severity: 'medium',
								actionHref: await projectAppHref(store, project.teamId, project.slug, 'overview'),
								itemKey: job.id,
								metadata: {
									code: typeof body.code === 'string' ? body.code : null,
									jobId: job.id,
								},
							});
						}
					}
					return c.json({
						ok: true,
						payload: decorateJob(runtime.resolved.config.baseUrl, await store.failJob(job.id, {
							code: typeof body.code === 'string' ? body.code : null,
							message: String(body.message),
						})),
					});
				});
}
