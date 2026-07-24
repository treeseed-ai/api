export function installOperationsPlatformRunnersAndJobsRoutes(context: any) {
	const { AGENT_PROMOTION_APPROVAL_DECISIONS, AGENT_TASK_SIGNATURES, AUTH_PROVIDERS, AgentSdk, CHECKOUT_COMMERCIAL_OFFER_MODES, CHECKOUT_OFFER_MODES, CHECKOUT_SUBSCRIPTION_OFFER_MODES, DatabaseAuthProvider, FEEDBACK_SCREENSHOT_TYPES, FEEDBACK_TYPES, GITHUB_ACTIONS_OIDC_ISSUER, HOST_KIND_SESSION_KEYS, LOCAL_CONTENT_COLLECTIONS, LOCAL_CONTENT_DEFAULTS, LOCAL_DECISION_TYPE_VALUES, LOCAL_WORK_CONTENT_COLLECTIONS, MARKET_EMAIL_CONFIRMATION_PREFIX, MAX_FEEDBACK_MESSAGE_LENGTH, MAX_FEEDBACK_SCREENSHOT_BYTES, MarketControlPlaneStore, NOTIFICATION_CONTENT_CAPABILITIES, PERSONAL_THEME_COMPILER_VERSION, PLAINTEXT_HOST_CREDENTIAL_FIELD_NAMES, PLATFORM_OPERATION_SCOPES, POSTGRES_AUTH_PROVIDER_ID, PROPOSAL_VERDICT_DECISION_TYPES, RemoteClient, RemoteOperationsClient, RemoteSdkClient, SENSITIVE_QUERY_PARAM_PATTERN, STRIPE_PRICE_MIRROR_OFFER_MODES, STRIPE_PRODUCT_MIRROR_OFFER_MODES, OperationsSdk, accountDeletionBlockers, accountDeletionConfirmationMatches, addRelationValue, apiDatabaseUrl, app, appendLaunchDeploymentEvent, appendLaunchPhaseProjection, appendProjectDeletionProgress, applyCommerceRefundState, applyContentPublishResult, applyHubLaunchFailure, applyHubLaunchResult, applySeedWithStore, artifactDownloadPayload, authConfig, authEmailDeliveryFailureDetail, authEmailDeliveryFailureReason, authProviderId, authTokenTimestampMillis, authTokenTimestampSeconds, availabilityAttempts, availabilityRateLimit, backfillUserEmailAddresses, base64Url, base64urlJson, bearerTokenFromRequest, buildCommerceCheckoutMetadata, buildCommerceStripeMetadata, buildGovernanceApprovalProjection, buildGovernanceProjection, buildInfrastructureProjection, buildKnowledgeArtifactProjection, buildKnowledgeProjection, buildLaunchCredentialOverlay, buildWorkdayProjection, canSkipCloudflareCleanupAfterFailedLaunch, canonicalArchitectureTopology, capacity, centralMarketProfile, checkoutGroupKey, checkoutGroupKind, checkoutGroupStatus, ciOperationForAction, cleanFeedbackString, cloudflareDeletionAuthenticationMessage, cloudflareDnsDomainsForHostValidation, cloudflareErrorMessage, cloudflareProjectDeletionResourceNames, cloudflareRequestForLaunchPreflight, cloudflareRequestForProjectDeletion, collectHostingAuditCredentialOverlay, commerceCheckoutError, commerceErrorResponse, commerceStripeLookupKey, commerceStripePriceParams, commerceStripeProductParams, commerceStripeSyncContext, config, configuredAuthProviderId, confirmationUrlFor, consumeReauthentication, contentRelationPolicy, createApiExtension, createCapacityControlPlane, createCipheriv, createClientEncryptedEscrowService, createCommerceCheckoutRun, createCommerceCheckoutRunForServiceContract, createDecipheriv, createDecisionFromProposals, createGitHubActionsSecretEnclave, createGitHubAppAdapter, createHash, createHmac, createMarketEmailConfirmation, createMarketPostgresDatabase, createMarketWebSession, createOrResendUserEmailAddress, createProjectHostCredentialSessions, createProjectInternalClient, createPublicKey, createRelatedLocalContentRecord, createStripeConnectService, createTreeDxCredentialBridge, createVerify, credentialSessionKey, credentialSessionSecret, db, decodeRouteParam, decorateJob, decoratePlatformOperation, decryptCredentialSessionPayload, decryptHostConfig, decryptTeamHostForLaunch, decryptedHostConfigSummary, defaultConfig, deleteCloudflareDnsRecordsForProject, deleteCloudflareProjectResources, deleteTeamCapacityAggregate, derivePlatformOperationNavigation, deriveProjectHostBindingsView, domainInZone, encryptCredentialSessionPayload, encryptedHostPayloadLooksValid, enqueueTreeDxProvisionOperation, ensureCommerceStripeCustomer, ensureMarketCredentialSchema, ensurePrincipal, entitlementRenewalStateFromSubscription, enumValue, exchangeProviderIdentity, executeInline, executeProjectApi, executeSdkOperation, existsSync, exportSeedWithStore, exposeAuthTokenForTests, fallbackRemoteCapability, findById, findDispatchCapability, getSiteAuthConfig, getUserEmailAddress, githubOidcJwksCache, githubRequestForProjectDeletion, grantCommerceEntitlementsForOrder, handleCommerceInvoiceWebhook, handleCommercePaymentIntentWebhook, handleCommerceSubscriptionWebhook, hasRecordedCloudflareRuntimeResources, hashMarketPassword, hostBindingRequiresUnlock, hostKindForBinding, hubRepositoryPolicies, inferZoneNameForDomain, installApiRequestLogger, installCapacityRoutes, installProjectDeploymentRoutes, isLocalAcceptanceServicePrincipal, isLoopbackUrl, isPlatformOperationTerminal, isTeamApiPrincipal, isValidPersonalThemeDraft, jsonError, jsonThrownError, launchCapabilityPreset, launchPlannerRepositoryTopology, listCloudflareNamedResources, listManagedHostsFromConfig, listUserEmailAddresses, loadGitHubOidcJwks, loadInfrastructureSeedState, loadKnowledgeContentEntries, loadNotificationPreferences, loadProjectHostBindingContext, loadTemplateCatalog, localAcceptanceAdminToken, localAcceptanceAuthEnabled, localContentPath, localContentRoot, logRequests, managedCloudflareConfigMissing, markdownToPlainProjectSummary, marketAuthContext, marketEmailTokenHash, marketProfilesForTeams, mergeCapability, mergeStringConfig, mkdir, nonSecretLaunchJobInput, normalizeAppearancePreference, normalizeAuditHostKinds, normalizeBaseUrl, normalizeCheckoutQuantity, normalizeCiEnvironment, normalizeDomainName, normalizeEmail, normalizeLocalContentInput, normalizeMarketProfile, normalizeNotificationPreferences, normalizeProjectDomainInput, normalizeProjectLaunchHostBindings, normalizeProviderCredentialConfig, normalizeRelationArray, normalizeRepositoryContentInput, normalizeRepositoryRelationArray, normalizeRepositorySlug, normalizeSeedEnvironments, normalizeTemplateLaunchRequirements, normalizeTemplateId, normalizeUsername, normalizedCloudflareKvNamespaceReference, operationTokenSecret, optionalTrimmedString, orderStatusFromPaymentGroup, parseBase64urlJson, parseBooleanEnvValue, parseJsonObject, parseYaml, passwordResetUrlFor, patchLaunchIntentForCredentialOverlay, paymentGroupStatusFromPaymentIntent, pbkdf2Sync, persistProjectHostBindingOperationMetadata, personalThemeFromRow, plaintextHostCredentialFieldPaths, planKnowledgeHubLaunch, planProjectHostBindingOperation, planSeedWithStore, platformOperationMutationError, principalCanManageCommerceProduct, principalHasGlobalPlatformRole, principalHasPermission, principalIsSeedAdmin, privateKnowledgeAuditPayload, processCommerceStripeWebhook, projectAllowedCiRepositories, projectApiConnection, projectAppHref, projectDeletionBlockerRows, projectDeletionConfirmationMatches, projectDeletionHostname, projectDeletionOperation, projectHostBindingMetadata, projectHostResponsePayload, providerConfigFor, providerCredentialValuesForAudit, providerJwksCache, publicPaymentGroups, randomBytes, randomUUID, readCapacityRequestObject, readFile, readJsonOrFormBody, readLocalContentRecord, recordContentNotificationEvent, recordFeedbackSubmission, recordPrivateKnowledgeAudit, redactCommerceOwnershipWorkflow, redactCommerceServiceRequestForBuyer, redactedRequestTarget, refreshCommercePaymentGroupState, refreshCommerceStripeAccount, rejectPlaintextHostCredentialFields, rejectProjectSecretUnlockMaterial, relative, remainingRefundableAmount, repositoryContentRelationPolicy, repositoryInventoryWithPlatform, requestClientIp, requestSessionMetadata, requireCatalogItemAccess, requireCommerceCapacityInquiryAccess, requireCommerceCapacityListingAccess, requireCommerceOfferAccess, requireCommerceProductAccess, requireCommerceVendorForStripe, requireConfiguredServiceCredential, requireConnectedProjectRuntime, requirePlatformRunner, requireProjectAccess, requireProjectRunner, requireSeedApplyAccess, requireSeedPlanAccess, requireSellerTeamAccess, requireServiceBuyerAccess, requireServiceParticipantAccess, requireServiceSellerAccess, requireTeamAccess, requireVendorOrderManager, resolve, resolveAgentArtifactBucket, resolveAgentTaskSignature, resolveApiConfig, resolveAuthApprovalBaseUrl, resolveCloudflareZoneForLaunchPreflight, resolveCommerceCheckoutItem, resolveFulfillmentArtifact, resolveLaunchTemplateRequirements, resolveOrderItemForRefund, resolvePlatformRepositoryDescriptor, resolvePlatformRunnerSecret, resolveProjectDeletionCloudflareZone, resolveProjectLaunchHostBindings, resolvePublicTreeDxTeam, resolveStripeEnvironment, resolveStripePublishableKey, resolveStripeWebhookSecret, resolveManagedCloudflareHostConfigFromConfig, resolveUiProjectionContext, resourceRowsFromLaunch, retryApiLaunchBootstrapFromRequest, rm, runProjectDeletionApiDestroy, runProjectLaunchApiBootstrap, runHostingAudit, runtime, runtimeMarketAuthProvider, runtimeProviders, safeFeedbackClient, safeFeedbackContext, safeFeedbackScreenshot, safePlatformOperationOutput, safePrivateKnowledgeSlug, safeTokenEquals, sanitizeLaunchResultForStorage, sanitizedReturnTo, scheduleBackgroundBootstrap, seedActor, seedCreatesMissingTeams, seedExistingTeamIds, selectDispatchTarget, sendAuthEmail, sendEmailConfirmation, sendTeamInviteEmail, sendWelcomeEmail, serializeFrontmatter, serializeUserEmailAddress, setPrimaryEmailAddress, sharedSdk, shouldBypassAcceptanceAuthEmailDelivery, shouldExposeNonProductionAuthDiagnostics, shouldLogApiRequests, signEditorialPreviewToken, signOperationToken, slugifyContent, slugifyRepositoryContent, sourceFromProjectDetails, store, stripeAccountMissingError, stripeAccountToConnectedAccountPatch, stripeClientSecret, stripeCommerceUrl, stripeConfiguredError, stripeConnectService, stripeMetadataValue, stripePriceTermsDrift, stripeRefundStatus, stripeTimestampToIso, stripeVendorApprovalError, subscriptionClientSecret, subscriptionStatusFromStripe, syncCommerceOfferStripeProduct, syncCommercePriceStripePrice, syncCommerceSubscriptionFromStripe, syncPrimaryEmailCaches, teamInviteAcceptUrlFor, timingSafeEqual, trimmedHeaderValue, uiRuntimeLocals, uniqueCloudflareKvNamespaceReferences, uniqueRelationArray, unknownKeys, unwrapLaunchOperationOutput, unwrapOperationPayload, updateCheckoutCompletionFromGroup, updateLaunchDeployments, validateCiRefForEnvironment, validateFeedbackAccess, validateMarketPassword, validateProjectSlug, validatePublicUsername, validateTeamHostCredentialPayload, verifiedEmailCount, verifyCloudflareDnsWriteForLaunch, verifyGitHubOidcToken, verifyMarketPassword, verifyOperationToken, verifyProviderIdToken, webAuthPayload, webSessionData, writeFile, writeLocalContentRecord, writeParsedLocalContentRecord, yamlLines, yamlScalar } = context;
	app.get('/v1/platform/operations', async (c) => {
					const auth = await ensurePrincipal(c);
					if (auth.response) return auth.response;
					if (!principalHasGlobalPlatformRole(auth.principal) && !principalHasPermission(auth.principal, 'platform:operations:read')) {
						return jsonError(c, 403, 'Permission denied.', { permission: 'platform:operations:read' });
					}
					const operations = await store.listPlatformOperations({ limit: c.req.query('limit') });
					return c.json({ ok: true, operations: operations.map((operation) => decoratePlatformOperation(runtime.resolved.config.baseUrl, operation)) });
				});
	
	app.post('/v1/platform/operations', async (c) => {
					const auth = await ensurePrincipal(c);
					if (auth.response) return auth.response;
					if (isTeamApiPrincipal(auth.principal) && !principalHasPermission(auth.principal, 'platform:operations:create')) {
						return jsonError(c, 403, 'Permission denied.', { permission: 'platform:operations:create' });
					}
					const body = await c.req.json().catch(() => ({}));
					const namespace = optionalTrimmedString(body.namespace);
					const operationName = optionalTrimmedString(body.operation);
					if (!namespace || !operationName) return jsonError(c, 400, 'namespace and operation are required.');
					const input = body.input && typeof body.input === 'object' && !Array.isArray(body.input) ? body.input : {};
					const approvalRequired = input.approvalRequired === true && input.approvalSatisfied !== true;
					const operation = await store.createPlatformOperation({
						namespace,
						operation: operationName,
						target: optionalTrimmedString(body.target) ?? 'market_operations_runner',
						status: approvalRequired ? 'waiting_for_approval' : optionalTrimmedString(body.status) ?? 'queued',
						idempotencyKey: optionalTrimmedString(body.idempotencyKey),
						input,
						requestedByType: isTeamApiPrincipal(auth.principal) ? 'team_api_key' : c.get('actorType') === 'service' ? 'service' : 'user',
						requestedById: auth.principal.id,
					});
					return c.json({ ok: true, operation: decoratePlatformOperation(runtime.resolved.config.baseUrl, operation) }, { status: 202 });
				});
	
	app.get('/v1/platform/operations/:operationId', async (c) => {
					const auth = await ensurePrincipal(c);
					if (auth.response) return auth.response;
					if (isTeamApiPrincipal(auth.principal) && !principalHasPermission(auth.principal, 'platform:operations:read')) {
						return jsonError(c, 403, 'Permission denied.', { permission: 'platform:operations:read' });
					}
					const operation = await store.findPlatformOperationById(c.req.param('operationId'));
					if (!operation) return jsonError(c, 404, `Unknown platform operation "${c.req.param('operationId')}".`);
					return c.json({ ok: true, operation: decoratePlatformOperation(runtime.resolved.config.baseUrl, operation) });
				});
	
	app.get('/v1/platform/operations/:operationId/events', async (c) => {
					const auth = await ensurePrincipal(c);
					if (auth.response) return auth.response;
					if (isTeamApiPrincipal(auth.principal) && !principalHasPermission(auth.principal, 'platform:operations:read')) {
						return jsonError(c, 403, 'Permission denied.', { permission: 'platform:operations:read' });
					}
					const operation = await store.findPlatformOperationById(c.req.param('operationId'));
					if (!operation) return jsonError(c, 404, `Unknown platform operation "${c.req.param('operationId')}".`);
					return c.json({ ok: true, events: await store.listPlatformOperationEvents(operation.id) });
				});
	
	app.post('/v1/platform/operations/:operationId/cancel', async (c) => {
					const auth = await ensurePrincipal(c);
					if (auth.response) return auth.response;
					if (isTeamApiPrincipal(auth.principal) && !principalHasPermission(auth.principal, 'platform:operations:cancel')) {
						return jsonError(c, 403, 'Permission denied.', { permission: 'platform:operations:cancel' });
					}
					const operation = await store.findPlatformOperationById(c.req.param('operationId'));
					if (!operation) return jsonError(c, 404, `Unknown platform operation "${c.req.param('operationId')}".`);
					const cancelled = await store.cancelPlatformOperation(operation.id);
					return c.json({ ok: true, operation: decoratePlatformOperation(runtime.resolved.config.baseUrl, cancelled) });
				});
	
	app.post('/v1/platform/operations/:operationId/retry', async (c) => {
					const auth = await ensurePrincipal(c);
					if (auth.response) return auth.response;
					if (isTeamApiPrincipal(auth.principal) && !principalHasPermission(auth.principal, 'platform:operations:retry')) {
						return jsonError(c, 403, 'Permission denied.', { permission: 'platform:operations:retry' });
					}
					const operation = await store.findPlatformOperationById(c.req.param('operationId'));
					if (!operation) return jsonError(c, 404, `Unknown platform operation "${c.req.param('operationId')}".`);
					if (!['failed', 'cancelled'].includes(operation.status)) {
						return jsonError(c, 409, 'Only failed or cancelled platform operations can be retried.', { status: operation.status });
					}
					const body = await c.req.json().catch(() => ({}));
					const retried = await store.retryPlatformOperation(operation.id, {
						inputPatch: body.inputPatch && typeof body.inputPatch === 'object' ? body.inputPatch : {},
					});
					return c.json({ ok: true, operation: decoratePlatformOperation(runtime.resolved.config.baseUrl, retried) }, { status: 202 });
				});
	
	app.post('/v1/platform/runners/register', async (c) => {
					const auth = await requirePlatformRunner(c, runtime.resolved.config);
					if (auth.response) return auth.response;
					const body = await c.req.json().catch(() => ({}));
					const runnerId = optionalTrimmedString(body.runnerId);
					if (!runnerId) return jsonError(c, 400, 'runnerId is required.');
					const runner = await store.upsertMarketOperationRunner({
						runnerId,
						runnerKey: optionalTrimmedString(body.runnerKey) ?? runnerId,
						name: optionalTrimmedString(body.name) ?? runnerId,
						environment: optionalTrimmedString(body.environment) ?? optionalTrimmedString(body.marketId) ?? 'unknown',
						version: optionalTrimmedString(body.version),
						capabilities: Array.isArray(body.capabilities) ? body.capabilities.map(String) : [],
						maxConcurrentJobs: body.maxConcurrentJobs,
						metadata: body.metadata && typeof body.metadata === 'object' ? body.metadata : {},
					});
					return c.json({ ok: true, runner });
				});
	
	app.post('/v1/platform/runners/heartbeat', async (c) => {
					const auth = await requirePlatformRunner(c, runtime.resolved.config);
					if (auth.response) return auth.response;
					const body = await c.req.json().catch(() => ({}));
					const runnerId = optionalTrimmedString(body.runnerId);
					if (!runnerId) return jsonError(c, 400, 'runnerId is required.');
					const runner = await store.upsertMarketOperationRunner({
						runnerId,
						runnerKey: optionalTrimmedString(body.runnerKey) ?? runnerId,
						name: optionalTrimmedString(body.name) ?? runnerId,
						environment: optionalTrimmedString(body.environment) ?? optionalTrimmedString(body.marketId) ?? 'unknown',
						status: optionalTrimmedString(body.status) ?? 'online',
						version: optionalTrimmedString(body.version),
						capabilities: Array.isArray(body.capabilities) ? body.capabilities.map(String) : [],
						activeJobCount: body.activeJobCount,
						maxConcurrentJobs: body.maxConcurrentJobs,
						metadata: body.metadata && typeof body.metadata === 'object' ? body.metadata : {},
					});
					return c.json({ ok: true, runner });
				});
	
	app.post('/v1/platform/runners/jobs/claim', async (c) => {
					const auth = await requirePlatformRunner(c, runtime.resolved.config);
					if (auth.response) return auth.response;
					const body = await c.req.json().catch(() => ({}));
					const runnerId = optionalTrimmedString(body.runnerId);
					if (!runnerId) return jsonError(c, 400, 'runnerId is required.');
					const operation = await store.claimPlatformOperation({
						runnerId,
						operationId: optionalTrimmedString(body.operationId),
						capabilities: Array.isArray(body.capabilities) ? body.capabilities.map(String) : [],
						limit: body.limit,
						leaseSeconds: body.leaseSeconds,
					});
					return c.json({ ok: true, operation: decoratePlatformOperation(runtime.resolved.config.baseUrl, operation) });
				});
	
	app.get('/v1/platform/runners/jobs/:operationId', async (c) => {
					const auth = await requirePlatformRunner(c, runtime.resolved.config);
					if (auth.response) return auth.response;
					const operation = await store.findPlatformOperationById(c.req.param('operationId'));
					if (!operation) return jsonError(c, 404, `Unknown platform operation "${c.req.param('operationId')}".`);
					return c.json({ ok: true, operation: decoratePlatformOperation(runtime.resolved.config.baseUrl, operation) });
				});
	
	app.post('/v1/platform/runners/jobs/:operationId/events', async (c) => {
					const auth = await requirePlatformRunner(c, runtime.resolved.config);
					if (auth.response) return auth.response;
					const operation = await store.findPlatformOperationById(c.req.param('operationId'));
					if (!operation) return jsonError(c, 404, `Unknown platform operation "${c.req.param('operationId')}".`);
					const body = await c.req.json().catch(() => ({}));
					const runnerId = optionalTrimmedString(body.runnerId);
					if (runnerId && operation.assignedRunnerId && operation.assignedRunnerId !== runnerId) {
						return jsonError(c, 409, 'Platform operation is assigned to a different runner.', { assignedRunnerId: operation.assignedRunnerId });
					}
					const event = body.event && typeof body.event === 'object' ? body.event : body;
					const kind = optionalTrimmedString(event.kind) ?? 'runner.event';
					const data = event.data && typeof event.data === 'object' ? event.data : {};
					return c.json({ ok: true, event: await store.appendPlatformOperationEvent(operation.id, kind, data) });
				});
	
	app.post('/v1/platform/runners/jobs/:operationId/checkpoint', async (c) => {
					const auth = await requirePlatformRunner(c, runtime.resolved.config);
					if (auth.response) return auth.response;
					const operation = await store.findPlatformOperationById(c.req.param('operationId'));
					if (!operation) return jsonError(c, 404, `Unknown platform operation "${c.req.param('operationId')}".`);
					const body = await c.req.json().catch(() => ({}));
					let checkpointed;
					try {
						checkpointed = await store.checkpointPlatformOperation(operation.id, {
							runnerId: optionalTrimmedString(body.runnerId),
							output: body.output,
							event: body.event,
						});
					} catch (error) {
						return platformOperationMutationError(c, error);
					}
					return c.json({ ok: true, operation: decoratePlatformOperation(runtime.resolved.config.baseUrl, checkpointed) });
				});
	
	app.post('/v1/platform/runners/jobs/:operationId/renew-lease', async (c) => {
					const auth = await requirePlatformRunner(c, runtime.resolved.config);
					if (auth.response) return auth.response;
					const operation = await store.findPlatformOperationById(c.req.param('operationId'));
					if (!operation) return jsonError(c, 404, `Unknown platform operation "${c.req.param('operationId')}".`);
					const body = await c.req.json().catch(() => ({}));
					let renewed;
					try {
						renewed = await store.renewPlatformOperationLease(operation.id, {
							runnerId: optionalTrimmedString(body.runnerId),
							leaseSeconds: body.leaseSeconds,
							event: body.event,
						});
					} catch (error) {
						return platformOperationMutationError(c, error);
					}
					return c.json({ ok: true, operation: decoratePlatformOperation(runtime.resolved.config.baseUrl, renewed) });
				});
	
	app.post('/v1/platform/runners/jobs/:operationId/cancel', async (c) => {
					const auth = await requirePlatformRunner(c, runtime.resolved.config);
					if (auth.response) return auth.response;
					const operation = await store.findPlatformOperationById(c.req.param('operationId'));
					if (!operation) return jsonError(c, 404, `Unknown platform operation "${c.req.param('operationId')}".`);
					const body = await c.req.json().catch(() => ({}));
					const runnerId = optionalTrimmedString(body.runnerId);
					if (runnerId && operation.assignedRunnerId && operation.assignedRunnerId !== runnerId) {
						return jsonError(c, 409, 'Platform operation is assigned to a different runner.', { assignedRunnerId: operation.assignedRunnerId });
					}
					const cancelled = await store.cancelPlatformOperation(operation.id);
					const event = body.event && typeof body.event === 'object' ? body.event : null;
					if (event) {
						await store.appendPlatformOperationEvent(operation.id, optionalTrimmedString(event.kind) ?? 'runner.cancelled', event.data && typeof event.data === 'object' ? event.data : {});
					}
					return c.json({ ok: true, operation: decoratePlatformOperation(runtime.resolved.config.baseUrl, cancelled) });
				});
	
	app.post('/v1/platform/runners/jobs/:operationId/complete', async (c) => {
					const auth = await requirePlatformRunner(c, runtime.resolved.config);
					if (auth.response) return auth.response;
					const operation = await store.findPlatformOperationById(c.req.param('operationId'));
					if (!operation) return jsonError(c, 404, `Unknown platform operation "${c.req.param('operationId')}".`);
					const body = await c.req.json().catch(() => ({}));
					let completed;
					try {
						completed = await store.completePlatformOperation(operation.id, {
							runnerId: optionalTrimmedString(body.runnerId),
							output: body.output,
							event: body.event,
						});
						if (operation.namespace === 'project' && operation.operation === 'web_deployment') {
							const output = body.output && typeof body.output === 'object' && !Array.isArray(body.output) ? body.output : {};
							const input = operation.input && typeof operation.input === 'object' && !Array.isArray(operation.input) ? operation.input : {};
							const deploymentId = optionalTrimmedString(output.deploymentId) ?? optionalTrimmedString(input.deploymentId);
							if (deploymentId) {
								const status = optionalTrimmedString(output.status) ?? (output.ok === true ? 'succeeded' : null);
								const terminalStatus = status === 'failed' ? 'failed' : status === 'succeeded' ? 'succeeded' : null;
								if (terminalStatus) {
									const updated = await store.updateProjectDeployment(deploymentId, {
										status: terminalStatus,
										externalWorkflow: output.externalWorkflow ?? null,
										target: output.target ?? null,
										monitor: output.monitor ?? null,
										summary: optionalTrimmedString(output.summary) ?? `Project web deployment ${terminalStatus}.`,
										error: terminalStatus === 'failed'
											? output.error ?? { code: 'project_web_deployment_failed', message: optionalTrimmedString(output.summary) ?? 'Project web deployment failed.' }
											: {},
									}).catch(() => null);
									if (updated) {
										await store.appendProjectDeploymentEvent(deploymentId, {
											kind: terminalStatus === 'failed' ? 'deployment.failed' : 'deployment.succeeded',
											message: optionalTrimmedString(output.summary) ?? `Project web deployment ${terminalStatus}.`,
											status: terminalStatus,
											severity: terminalStatus === 'failed' ? 'error' : 'info',
											operationId: operation.id,
											payload: {
												externalWorkflow: output.externalWorkflow ?? null,
												target: output.target ?? null,
												monitor: output.monitor ?? null,
											},
										}).catch(() => null);
									}
								}
							}
						}
					} catch (error) {
						return platformOperationMutationError(c, error);
					}
					return c.json({ ok: true, operation: decoratePlatformOperation(runtime.resolved.config.baseUrl, completed) });
				});
	
	app.post('/v1/platform/runners/jobs/:operationId/fail', async (c) => {
					const auth = await requirePlatformRunner(c, runtime.resolved.config);
					if (auth.response) return auth.response;
					const operation = await store.findPlatformOperationById(c.req.param('operationId'));
					if (!operation) return jsonError(c, 404, `Unknown platform operation "${c.req.param('operationId')}".`);
					const body = await c.req.json().catch(() => ({}));
					let failed;
					try {
						failed = await store.failPlatformOperation(operation.id, {
							runnerId: optionalTrimmedString(body.runnerId),
							error: body.error ?? { message: 'Platform operation failed.' },
							event: body.event,
						});
					} catch (error) {
						return platformOperationMutationError(c, error);
					}
					return c.json({ ok: true, operation: decoratePlatformOperation(runtime.resolved.config.baseUrl, failed) });
				});
}
