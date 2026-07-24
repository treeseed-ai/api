export function installProjectsCapabilitiesContentAndCiRoutes(context: any) {
	const { AGENT_PROMOTION_APPROVAL_DECISIONS, AGENT_TASK_SIGNATURES, AUTH_PROVIDERS, AgentSdk, CHECKOUT_COMMERCIAL_OFFER_MODES, CHECKOUT_OFFER_MODES, CHECKOUT_SUBSCRIPTION_OFFER_MODES, DatabaseAuthProvider, FEEDBACK_SCREENSHOT_TYPES, FEEDBACK_TYPES, GITHUB_ACTIONS_OIDC_ISSUER, HOST_KIND_SESSION_KEYS, LOCAL_CONTENT_COLLECTIONS, LOCAL_CONTENT_DEFAULTS, LOCAL_DECISION_TYPE_VALUES, LOCAL_WORK_CONTENT_COLLECTIONS, MARKET_EMAIL_CONFIRMATION_PREFIX, MAX_FEEDBACK_MESSAGE_LENGTH, MAX_FEEDBACK_SCREENSHOT_BYTES, MarketControlPlaneStore, NOTIFICATION_CONTENT_CAPABILITIES, PERSONAL_THEME_COMPILER_VERSION, PLAINTEXT_HOST_CREDENTIAL_FIELD_NAMES, PLATFORM_OPERATION_SCOPES, POSTGRES_AUTH_PROVIDER_ID, PROPOSAL_VERDICT_DECISION_TYPES, RemoteTreeseedClient, RemoteTreeseedOperationsClient, RemoteTreeseedSdkClient, SENSITIVE_QUERY_PARAM_PATTERN, STRIPE_PRICE_MIRROR_OFFER_MODES, STRIPE_PRODUCT_MIRROR_OFFER_MODES, TreeseedOperationsSdk, accountDeletionBlockers, accountDeletionConfirmationMatches, addRelationValue, apiDatabaseUrl, app, appendLaunchDeploymentEvent, appendLaunchPhaseProjection, appendProjectDeletionProgress, applyCommerceRefundState, applyContentPublishResult, applyHubLaunchFailure, applyHubLaunchResult, applySeedWithStore, artifactDownloadPayload, authConfig, authEmailDeliveryFailureDetail, authEmailDeliveryFailureReason, authProviderId, authTokenTimestampMillis, authTokenTimestampSeconds, availabilityAttempts, availabilityRateLimit, backfillUserEmailAddresses, base64Url, base64urlJson, bearerTokenFromRequest, buildCommerceCheckoutMetadata, buildCommerceStripeMetadata, buildGovernanceApprovalProjection, buildGovernanceProjection, buildInfrastructureProjection, buildKnowledgeArtifactProjection, buildKnowledgeProjection, buildLaunchCredentialOverlay, buildWorkdayProjection, canSkipCloudflareCleanupAfterFailedLaunch, canonicalArchitectureTopology, capacity, centralMarketProfile, checkoutGroupKey, checkoutGroupKind, checkoutGroupStatus, ciOperationForAction, cleanFeedbackString, cloudflareDeletionAuthenticationMessage, cloudflareDnsDomainsForHostValidation, cloudflareErrorMessage, cloudflareProjectDeletionResourceNames, cloudflareRequestForLaunchPreflight, cloudflareRequestForProjectDeletion, collectHostingAuditCredentialOverlay, commerceCheckoutError, commerceErrorResponse, commerceStripeLookupKey, commerceStripePriceParams, commerceStripeProductParams, commerceStripeSyncContext, config, configuredAuthProviderId, confirmationUrlFor, consumeReauthentication, contentRelationPolicy, createApiApp, createApiExtension, createCapacityControlPlane, createCipheriv, createClientEncryptedEscrowService, createCommerceCheckoutRun, createCommerceCheckoutRunForServiceContract, createDecipheriv, createDecisionFromProposals, createGitHubActionsSecretEnclave, createGitHubAppAdapter, createHash, createHmac, createMarketEmailConfirmation, createMarketPostgresDatabase, createMarketWebSession, createOrResendUserEmailAddress, createProjectHostCredentialSessions, createProjectInternalClient, createPublicKey, createRelatedLocalContentRecord, createStripeConnectService, createTreeDxCredentialBridge, createTreeseedApiApp, createVerify, credentialSessionKey, credentialSessionSecret, db, decodeRouteParam, decorateJob, decoratePlatformOperation, decryptCredentialSessionPayload, decryptHostConfig, decryptTeamHostForLaunch, decryptedHostConfigSummary, defaultConfig, deleteCloudflareDnsRecordsForProject, deleteCloudflareProjectResources, deleteTeamCapacityAggregate, derivePlatformOperationNavigation, deriveProjectHostBindingsView, domainInZone, encryptCredentialSessionPayload, encryptedHostPayloadLooksValid, enqueueTreeDxProvisionOperation, ensureCommerceStripeCustomer, ensureMarketCredentialSchema, ensurePrincipal, entitlementRenewalStateFromSubscription, enumValue, exchangeProviderIdentity, executeInline, executeProjectApi, executeSdkOperation, existsSync, exportSeedWithStore, exposeAuthTokenForTests, fallbackRemoteCapability, findById, findDispatchCapability, getSiteAuthConfig, getUserEmailAddress, githubOidcJwksCache, githubRequestForProjectDeletion, grantCommerceEntitlementsForOrder, handleCommerceInvoiceWebhook, handleCommercePaymentIntentWebhook, handleCommerceSubscriptionWebhook, hasRecordedCloudflareRuntimeResources, hashMarketPassword, hostBindingRequiresUnlock, hostKindForBinding, hubRepositoryPolicies, inferZoneNameForDomain, installApiRequestLogger, installCapacityRoutes, installProjectDeploymentRoutes, isLocalAcceptanceServicePrincipal, isLoopbackUrl, isPlatformOperationTerminal, isTeamApiPrincipal, isValidPersonalThemeDraft, jsonError, jsonThrownError, launchCapabilityPreset, launchPlannerRepositoryTopology, listCloudflareNamedResources, listTreeseedManagedHostsFromConfig, listUserEmailAddresses, loadGitHubOidcJwks, loadInfrastructureSeedState, loadKnowledgeContentEntries, loadNotificationPreferences, loadProjectHostBindingContext, loadTemplateCatalog, localAcceptanceAdminToken, localAcceptanceAuthEnabled, localContentPath, localContentRoot, logRequests, managedCloudflareConfigMissing, markdownToPlainProjectSummary, marketAuthContext, marketEmailTokenHash, marketProfilesForTeams, mergeCapability, mergeStringConfig, mkdir, nonSecretLaunchJobInput, normalizeAppearancePreference, normalizeAuditHostKinds, normalizeBaseUrl, normalizeCheckoutQuantity, normalizeCiEnvironment, normalizeDomainName, normalizeEmail, normalizeLocalContentInput, normalizeMarketProfile, normalizeNotificationPreferences, normalizeProjectDomainInput, normalizeProjectLaunchHostBindings, normalizeProviderCredentialConfig, normalizeRelationArray, normalizeRepositoryContentInput, normalizeRepositoryRelationArray, normalizeRepositorySlug, normalizeSeedEnvironments, normalizeTemplateLaunchRequirements, normalizeTreeseedTemplateId, normalizeUsername, normalizedCloudflareKvNamespaceReference, operationTokenSecret, optionalTrimmedString, orderStatusFromPaymentGroup, parseBase64urlJson, parseBooleanEnvValue, parseJsonObject, parseYaml, passwordResetUrlFor, patchLaunchIntentForCredentialOverlay, paymentGroupStatusFromPaymentIntent, pbkdf2Sync, persistProjectHostBindingOperationMetadata, personalThemeFromRow, plaintextHostCredentialFieldPaths, planKnowledgeHubLaunch, planProjectHostBindingOperation, planSeedWithStore, platformOperationMutationError, principalCanManageCommerceProduct, principalHasGlobalPlatformRole, principalHasPermission, principalIsSeedAdmin, privateKnowledgeAuditPayload, processCommerceStripeWebhook, projectAllowedCiRepositories, projectApiConnection, projectAppHref, projectDeletionBlockerRows, projectDeletionConfirmationMatches, projectDeletionHostname, projectDeletionOperation, projectHostBindingMetadata, projectHostResponsePayload, providerConfigFor, providerCredentialValuesForAudit, providerJwksCache, publicPaymentGroups, randomBytes, randomUUID, readCapacityRequestObject, readFile, readJsonOrFormBody, readLocalContentRecord, recordContentNotificationEvent, recordFeedbackSubmission, recordPrivateKnowledgeAudit, redactCommerceOwnershipWorkflow, redactCommerceServiceRequestForBuyer, redactedRequestTarget, refreshCommercePaymentGroupState, refreshCommerceStripeAccount, rejectPlaintextHostCredentialFields, rejectProjectSecretUnlockMaterial, relative, remainingRefundableAmount, repositoryContentRelationPolicy, repositoryInventoryWithPlatform, requestClientIp, requestSessionMetadata, requireCatalogItemAccess, requireCommerceCapacityInquiryAccess, requireCommerceCapacityListingAccess, requireCommerceOfferAccess, requireCommerceProductAccess, requireCommerceVendorForStripe, requireConfiguredServiceCredential, requireConnectedProjectRuntime, requirePlatformRunner, requireProjectAccess, requireProjectRunner, requireSeedApplyAccess, requireSeedPlanAccess, requireSellerTeamAccess, requireServiceBuyerAccess, requireServiceParticipantAccess, requireServiceSellerAccess, requireTeamAccess, requireVendorOrderManager, resolve, resolveAgentArtifactBucket, resolveAgentTaskSignature, resolveApiConfig, resolveAuthApprovalBaseUrl, resolveCloudflareZoneForLaunchPreflight, resolveCommerceCheckoutItem, resolveFulfillmentArtifact, resolveLaunchTemplateRequirements, resolveOrderItemForRefund, resolvePlatformRepositoryDescriptor, resolvePlatformRunnerSecret, resolveProjectDeletionCloudflareZone, resolveProjectLaunchHostBindings, resolvePublicTreeDxTeam, resolveStripeEnvironment, resolveStripePublishableKey, resolveStripeWebhookSecret, resolveTreeseedManagedCloudflareHostConfigFromConfig, resolveUiProjectionContext, resourceRowsFromLaunch, retryApiLaunchBootstrapFromRequest, rm, runProjectDeletionApiDestroy, runProjectLaunchApiBootstrap, runTreeseedHostingAudit, runtime, runtimeMarketAuthProvider, runtimeProviders, safeFeedbackClient, safeFeedbackContext, safeFeedbackScreenshot, safePlatformOperationOutput, safePrivateKnowledgeSlug, safeTokenEquals, sanitizeLaunchResultForStorage, sanitizedReturnTo, scheduleBackgroundBootstrap, seedActor, seedCreatesMissingTeams, seedExistingTeamIds, selectDispatchTarget, sendAuthEmail, sendEmailConfirmation, sendTeamInviteEmail, sendWelcomeEmail, serializeFrontmatter, serializeUserEmailAddress, setPrimaryEmailAddress, sharedSdk, shouldBypassAcceptanceAuthEmailDelivery, shouldExposeNonProductionAuthDiagnostics, shouldLogApiRequests, signEditorialPreviewToken, signOperationToken, slugifyContent, slugifyRepositoryContent, sourceFromProjectDetails, store, stripeAccountMissingError, stripeAccountToConnectedAccountPatch, stripeClientSecret, stripeCommerceUrl, stripeConfiguredError, stripeConnectService, stripeMetadataValue, stripePriceTermsDrift, stripeRefundStatus, stripeTimestampToIso, stripeVendorApprovalError, subscriptionClientSecret, subscriptionStatusFromStripe, syncCommerceOfferStripeProduct, syncCommercePriceStripePrice, syncCommerceSubscriptionFromStripe, syncPrimaryEmailCaches, teamInviteAcceptUrlFor, timingSafeEqual, trimmedHeaderValue, uiRuntimeLocals, uniqueCloudflareKvNamespaceReferences, uniqueRelationArray, unknownKeys, unwrapLaunchOperationOutput, unwrapOperationPayload, updateCheckoutCompletionFromGroup, updateLaunchDeployments, validateCiRefForEnvironment, validateFeedbackAccess, validateMarketPassword, validateProjectSlug, validatePublicUsername, validateTeamHostCredentialPayload, verifiedEmailCount, verifyCloudflareDnsWriteForLaunch, verifyGitHubOidcToken, verifyMarketPassword, verifyOperationToken, verifyProviderIdToken, webAuthPayload, webSessionData, writeFile, writeLocalContentRecord, writeParsedLocalContentRecord, yamlLines, yamlScalar } = context;
	app.post('/v1/projects/:projectId/capabilities', async (c) => {
					const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:manage:team');
					if (access.response) return access.response;
					const body = await c.req.json().catch(() => ({}));
					const grants = Array.isArray(body.grants) ? body.grants : [];
					return c.json({
						ok: true,
						payload: await store.replaceProjectCapabilities(c.req.param('projectId'), grants.map((grant) => ({
							namespace: String(grant.namespace ?? 'sdk'),
							operation: String(grant.operation ?? ''),
							label: typeof grant.label === 'string' ? grant.label : null,
							executionClass: String(grant.executionClass ?? 'remote_inline'),
							allowedTargets: Array.isArray(grant.allowedTargets) ? grant.allowedTargets.map(String) : [],
							defaultDispatchMode: String(grant.defaultDispatchMode ?? 'auto'),
							enabled: grant.enabled !== false,
							approvalPolicy: grant.approvalPolicy && typeof grant.approvalPolicy === 'object' ? grant.approvalPolicy : {},
							resourceScope: grant.resourceScope && typeof grant.resourceScope === 'object' ? grant.resourceScope : {},
							metadata: grant.metadata && typeof grant.metadata === 'object' ? grant.metadata : {},
						}))),
					});
				});
	
	app.get('/v1/projects/:projectId/workspace-links', async (c) => {
					const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:read:team');
					if (access.response) return access.response;
					return c.json({ ok: true, payload: await store.listHubWorkspaceLinks(access.details.project.id) });
				});
	
	app.post('/v1/projects/:projectId/workspace-links', async (c) => {
					const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:manage:team');
					if (access.response) return access.response;
					const body = await c.req.json().catch(() => ({}));
					const link = await store.upsertHubWorkspaceLink(access.details.project.id, {
						...body,
						teamId: access.details.project.teamId,
					});
					const job = await store.createJob({
						projectId: access.details.project.id,
						namespace: 'workspace',
						operation: 'attach_parent',
						status: 'pending',
						preferredMode: 'auto',
						selectedTarget: 'project_runner',
						requestedByType: isTeamApiPrincipal(access.principal) ? 'team_api_key' : c.get('actorType') === 'service' ? 'service' : 'user',
						requestedById: access.principal.id,
						input: {
							workspaceLinkId: link.id,
							workspace: link,
						},
					});
					return c.json({ ok: true, payload: { link, job: decorateJob(runtime.resolved.config.baseUrl, job) } }, { status: 202 });
				});
	
	app.get('/v1/projects/:projectId/update-plans', async (c) => {
					const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:read:team');
					if (access.response) return access.response;
					return c.json({ ok: true, payload: await store.listProjectUpdatePlans(access.details.project.id) });
				});
	
	app.post('/v1/projects/:projectId/local-content/decisions/from-proposals', async (c) => {
					const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:manage:team');
					if (access.response) return access.response;
					const body = await readJsonOrFormBody(c);
					const repository = resolvePlatformRepositoryDescriptor(runtime.resolved.config, access.details, body);
					const proposalSlugs = [...new Set(normalizeRepositoryRelationArray(body.proposalSlugs))];
					if (proposalSlugs.length === 0) return jsonError(c, 400, 'Select at least one proposal.');
					if (proposalSlugs.some((slug) => !slug || slugifyRepositoryContent(slug) !== slug)) return jsonError(c, 400, 'Unsafe proposal slug.');
					const decisionType = enumValue(body.decisionType, [...PROPOSAL_VERDICT_DECISION_TYPES], null);
					if (!decisionType) return jsonError(c, 400, 'Unsupported proposal verdict.');
					const reason = optionalTrimmedString(body.reason) ?? optionalTrimmedString(body.rationale);
					if (!reason) return jsonError(c, 400, 'A decision reason is required.');
					const title = optionalTrimmedString(body.title) ?? `Decision for ${proposalSlugs.length === 1 ? proposalSlugs[0] : `${proposalSlugs.length} proposals`}`;
					const decisionSlug = slugifyRepositoryContent(body.slug || title);
					if (!decisionSlug) return jsonError(c, 400, 'A safe decision slug is required.');
					const job = await store.createPlatformOperation({
						namespace: 'repository',
						operation: 'create_decision_from_proposals',
						target: 'market_operations_runner',
						idempotencyKey: optionalTrimmedString(body.idempotencyKey),
						requestedByType: isTeamApiPrincipal(access.principal) ? 'team_api_key' : c.get('actorType') === 'service' ? 'service' : 'user',
						requestedById: access.principal.id,
						input: {
							projectId: access.details.project.id,
							teamId: access.details.project.teamId,
							createdBy: access.principal.id,
							repository,
							proposalSlugs,
							decisionType,
							reason,
							title,
							slug: decisionSlug,
							payload: body,
						},
					});
					return c.json({ ok: true, job: decoratePlatformOperation(runtime.resolved.config.baseUrl, job) }, { status: 202 });
				});
	
	app.post('/v1/projects/:projectId/local-content/:collection', async (c) => {
					const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:manage:team');
					if (access.response) return access.response;
					const collection = String(c.req.param('collection') ?? '');
					const body = await readJsonOrFormBody(c);
					const repository = resolvePlatformRepositoryDescriptor(runtime.resolved.config, access.details, body);
					const normalized = normalizeRepositoryContentInput(collection, {
						...body,
						projectId: access.details.project.id,
						teamId: access.details.project.teamId,
						createdBy: access.principal.id,
					});
					if (normalized.error) return jsonError(c, 400, normalized.error);
					const job = await store.createPlatformOperation({
						namespace: 'repository',
						operation: 'write_content_record',
						target: 'market_operations_runner',
						idempotencyKey: optionalTrimmedString(body.idempotencyKey),
						requestedByType: isTeamApiPrincipal(access.principal) ? 'team_api_key' : c.get('actorType') === 'service' ? 'service' : 'user',
						requestedById: access.principal.id,
						input: {
							projectId: access.details.project.id,
							teamId: access.details.project.teamId,
							createdBy: access.principal.id,
							repository,
							collection,
							normalized,
							payload: body,
						},
					});
					return c.json({ ok: true, job: decoratePlatformOperation(runtime.resolved.config.baseUrl, job) }, { status: 202 });
				});
	
	app.post('/v1/projects/:projectId/local-content/:collection/related', async (c) => {
					const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:manage:team');
					if (access.response) return access.response;
					const routeCollection = String(c.req.param('collection') ?? '');
					const body = await readJsonOrFormBody(c);
					const parentCollection = optionalTrimmedString(body.parentCollection) ?? routeCollection;
					const targetCollection = optionalTrimmedString(body.targetCollection) ?? routeCollection;
					const parentSlug = optionalTrimmedString(body.parentSlug);
					if (!parentSlug) return jsonError(c, 400, 'parentSlug is required.');
					if (targetCollection !== routeCollection) {
						return jsonError(c, 400, 'Route collection must match targetCollection.');
					}
					const repository = resolvePlatformRepositoryDescriptor(runtime.resolved.config, access.details, body);
					const policy = repositoryContentRelationPolicy(parentCollection, targetCollection);
					if (!policy) return jsonError(c, 400, `Cannot create related ${targetCollection} from ${parentCollection}.`);
					const normalized = normalizeRepositoryContentInput(targetCollection, {
						...body,
						projectId: access.details.project.id,
						teamId: access.details.project.teamId,
						createdBy: access.principal.id,
					});
					if (normalized.error) return jsonError(c, 400, normalized.error);
					const job = await store.createPlatformOperation({
						namespace: 'repository',
						operation: 'create_related_content',
						target: 'market_operations_runner',
						idempotencyKey: optionalTrimmedString(body.idempotencyKey),
						requestedByType: isTeamApiPrincipal(access.principal) ? 'team_api_key' : c.get('actorType') === 'service' ? 'service' : 'user',
						requestedById: access.principal.id,
						input: {
							projectId: access.details.project.id,
							teamId: access.details.project.teamId,
							createdBy: access.principal.id,
							repository,
							parentCollection,
							parentSlug,
							targetCollection,
							normalized,
							relation: {
								parentField: policy.sourceField,
								childField: policy.targetField,
							},
							payload: body,
						},
					});
					return c.json({ ok: true, job: decoratePlatformOperation(runtime.resolved.config.baseUrl, job) }, { status: 202 });
				});
	
	app.post('/v1/projects/:projectId/update-plans', async (c) => {
					const access = await requireProjectAccess(c, store, c.req.param('projectId'), 'projects:manage:team');
					if (access.response) return access.response;
					const body = await c.req.json().catch(() => ({}));
					const plan = await store.createProjectUpdatePlan(access.details.project.id, {
						...body,
						teamId: access.details.project.teamId,
						createdBy: access.principal.id,
					});
					const job = await store.createJob({
						projectId: access.details.project.id,
						namespace: 'hub',
						operation: 'execute_update',
						status: plan.requiresDecision ? 'waiting_for_approval' : 'pending',
						preferredMode: 'auto',
						selectedTarget: 'project_runner',
						requestedByType: isTeamApiPrincipal(access.principal) ? 'team_api_key' : c.get('actorType') === 'service' ? 'service' : 'user',
						requestedById: access.principal.id,
						input: {
							updatePlanId: plan.id,
							plan: plan.plan,
							decisionId: plan.decisionId,
						},
					});
					return c.json({ ok: true, payload: { plan, job: decorateJob(runtime.resolved.config.baseUrl, job) } }, { status: 202 });
				});
	
	app.post('/v1/projects/:projectId/ci/oidc/exchange', async (c) => {
					const projectId = c.req.param('projectId');
					const details = await store.getProjectDetails(projectId);
					if (!details) {
						return jsonError(c, 404, `Unknown project "${projectId}".`);
					}
					const body = await c.req.json().catch(() => ({}));
					const oidcToken = typeof body.oidcToken === 'string' ? body.oidcToken.trim() : '';
					if (!oidcToken) {
						return jsonError(c, 400, 'oidcToken is required.');
					}
					let claims;
					try {
						claims = await verifyGitHubOidcToken(oidcToken, `treeseed:${projectId}`, c.env?.fetch ?? fetch);
					} catch (error) {
						return jsonError(c, 401, 'GitHub OIDC token could not be verified.', {
							message: error instanceof Error ? error.message : String(error),
						});
					}
					const repository = normalizeRepositorySlug(claims.repository);
					const allowedRepositories = projectAllowedCiRepositories(details);
					if (!repository || !allowedRepositories.has(repository)) {
						return jsonError(c, 403, 'GitHub OIDC repository is not allowed to request operations for this project.', {
							repository,
						});
					}
					const environment = normalizeCiEnvironment(body.environment);
					if (!validateCiRefForEnvironment(environment, claims)) {
						return jsonError(c, 403, 'GitHub OIDC ref is not allowed for the requested environment.', {
							environment,
							ref: claims.ref ?? null,
						});
					}
					const workflowRef = String(claims.workflow_ref ?? '');
					if (
						!workflowRef.includes(`${repository}/.github/workflows/deploy-web.yml@`)
					) {
						return jsonError(c, 403, 'GitHub OIDC workflow_ref must come from the managed deploy workflow.');
					}
					const actionKind = typeof body.actionKind === 'string' ? body.actionKind : 'deploy_web';
					const operation = ciOperationForAction(actionKind);
					const baseCapability = findDispatchCapability(operation.namespace, operation.operation)
						?? fallbackRemoteCapability(operation.namespace, operation.operation);
					const override = await store.getEffectiveCapability(projectId, operation.namespace, operation.operation);
					if (override && override.enabled === false) {
						return jsonError(c, 403, 'Managed operation capability is disabled for this project.', operation);
					}
					const capability = mergeCapability(baseCapability, override);
					const approvalPolicy = capability.approvalPolicy && typeof capability.approvalPolicy === 'object'
						? capability.approvalPolicy
						: {};
					const requiresApproval = approvalPolicy.requiresApproval === true;
					const sha = typeof claims.sha === 'string' && claims.sha.trim()
						? claims.sha.trim()
						: typeof body.sha === 'string' ? body.sha.trim() : null;
					const input = {
						...(typeof body.input === 'object' && body.input ? body.input : {}),
						environment,
						ci: {
							provider: 'github_actions',
							repository,
							ref: claims.ref ?? null,
							refName: claims.ref_name ?? body.refName ?? null,
							sha,
							workflow: claims.workflow ?? body.workflow ?? null,
							workflowRef: claims.workflow_ref ?? body.workflowRef ?? null,
							runId: claims.run_id ?? body.runId ?? null,
							runAttempt: claims.run_attempt ?? body.runAttempt ?? null,
							actor: claims.actor ?? null,
							trigger: claims.event_name ?? null,
						},
						managedHostExecution: {
							mode: 'treeseed_managed',
							credentialExposure: 'none',
						},
						...(requiresApproval ? { approvalPolicy } : {}),
					};
					const job = await store.createJob({
						projectId,
						namespace: operation.namespace,
						operation: operation.operation,
						status: requiresApproval ? 'waiting_for_approval' : 'pending',
						input,
						preferredMode: 'auto',
						selectedTarget: 'project_runner',
						idempotencyKey: `ci:${projectId}:${actionKind}:${environment}:${sha ?? claims.run_id ?? randomBytes(6).toString('hex')}`,
						requestedByType: 'ci_oidc',
						requestedById: repository,
						capability,
					});
					await store.appendJobEvent(job.id, requiresApproval ? 'approval_required' : 'ci_operation_requested', {
						actionKind,
						environment,
						repository,
						ref: claims.ref ?? null,
						sha,
						approvalPolicy: requiresApproval ? approvalPolicy : null,
					});
					if (requiresApproval) {
						await store.upsertTeamInboxItem(details.project.teamId, {
							id: `job-approval:${job.id}`,
							projectId: details.project.id,
							kind: 'approval_required',
							state: 'open',
							title: `${capability.label ?? `${operation.namespace}.${operation.operation}`} needs approval`,
							summary: approvalPolicy.reason ?? 'This managed operation requires human approval before TreeSeed can run it.',
							href: await projectAppHref(store, details.project.teamId, details.project.slug, 'overview'),
							itemKey: job.id,
							metadata: {
								jobId: job.id,
								approvalPolicy,
								resourceScope: capability.resourceScope ?? {},
							},
						});
					}
					const operationToken = signOperationToken(runtime, {
						projectId,
						jobId: job.id,
						repository,
						operation: `${operation.namespace}.${operation.operation}`,
						exp: Math.floor(Date.now() / 1000) + 30 * 60,
					});
					return c.json({
						ok: true,
						payload: {
							job: decorateJob(runtime.resolved.config.baseUrl, job),
							operationToken,
						},
					}, { status: 202 });
				});
}
