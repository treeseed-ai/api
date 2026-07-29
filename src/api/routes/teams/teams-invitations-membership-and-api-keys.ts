export function installTeamsInvitationsMembershipAndApiKeysRoutes(context: any) {
	const { AGENT_PROMOTION_APPROVAL_DECISIONS, AGENT_TASK_SIGNATURES, AUTH_PROVIDERS, AgentSdk, CHECKOUT_COMMERCIAL_OFFER_MODES, CHECKOUT_OFFER_MODES, CHECKOUT_SUBSCRIPTION_OFFER_MODES, DatabaseAuthProvider, FEEDBACK_SCREENSHOT_TYPES, FEEDBACK_TYPES, GITHUB_ACTIONS_OIDC_ISSUER, HOST_KIND_SESSION_KEYS, LOCAL_CONTENT_COLLECTIONS, LOCAL_CONTENT_DEFAULTS, LOCAL_DECISION_TYPE_VALUES, LOCAL_WORK_CONTENT_COLLECTIONS, MARKET_EMAIL_CONFIRMATION_PREFIX, MAX_FEEDBACK_MESSAGE_LENGTH, MAX_FEEDBACK_SCREENSHOT_BYTES, MarketControlPlaneStore, NOTIFICATION_CONTENT_CAPABILITIES, PERSONAL_THEME_COMPILER_VERSION, PLAINTEXT_HOST_CREDENTIAL_FIELD_NAMES, PLATFORM_OPERATION_SCOPES, POSTGRES_AUTH_PROVIDER_ID, PROPOSAL_VERDICT_DECISION_TYPES, RemoteClient, RemoteOperationsClient, RemoteSdkClient, SENSITIVE_QUERY_PARAM_PATTERN, STRIPE_PRICE_MIRROR_OFFER_MODES, STRIPE_PRODUCT_MIRROR_OFFER_MODES, OperationsSdk, accountDeletionBlockers, accountDeletionConfirmationMatches, addRelationValue, apiDatabaseUrl, app, appendLaunchDeploymentEvent, appendLaunchPhaseProjection, appendProjectDeletionProgress, applyCommerceRefundState, applyContentPublishResult, applyHubLaunchFailure, applyHubLaunchResult, applySeedWithStore, artifactDownloadPayload, authConfig, authEmailDeliveryFailureDetail, authEmailDeliveryFailureReason, authProviderId, authTokenTimestampMillis, authTokenTimestampSeconds, availabilityAttempts, availabilityRateLimit, backfillUserEmailAddresses, base64Url, base64urlJson, bearerTokenFromRequest, buildCommerceCheckoutMetadata, buildCommerceStripeMetadata, buildGovernanceApprovalProjection, buildGovernanceProjection, buildInfrastructureProjection, buildKnowledgeArtifactProjection, buildKnowledgeProjection, buildLaunchCredentialOverlay, buildWorkdayProjection, canSkipCloudflareCleanupAfterFailedLaunch, canonicalArchitectureTopology, capacity, centralMarketProfile, checkoutGroupKey, checkoutGroupKind, checkoutGroupStatus, ciOperationForAction, cleanFeedbackString, cloudflareDeletionAuthenticationMessage, cloudflareDnsDomainsForHostValidation, cloudflareErrorMessage, cloudflareProjectDeletionResourceNames, cloudflareRequestForLaunchPreflight, cloudflareRequestForProjectDeletion, collectHostingAuditCredentialOverlay, commerceCheckoutError, commerceErrorResponse, commerceStripeLookupKey, commerceStripePriceParams, commerceStripeProductParams, commerceStripeSyncContext, config, configuredAuthProviderId, confirmationUrlFor, consumeReauthentication, contentRelationPolicy, createApiExtension, createCapacityControlPlane, createCipheriv, createClientEncryptedEscrowService, createCommerceCheckoutRun, createCommerceCheckoutRunForServiceContract, createDecipheriv, createDecisionFromProposals, createGitHubActionsSecretEnclave, createGitHubAppAdapter, createHash, createHmac, createMarketEmailConfirmation, createMarketPostgresDatabase, createMarketWebSession, createOrResendUserEmailAddress, createProjectHostCredentialSessions, createProjectInternalClient, createPublicKey, createRelatedLocalContentRecord, createStripeConnectService, createTreeDxCredentialBridge, createVerify, credentialSessionKey, credentialSessionSecret, db, decodeRouteParam, decorateJob, decoratePlatformOperation, decryptCredentialSessionPayload, decryptHostConfig, decryptTeamHostForLaunch, decryptedHostConfigSummary, defaultConfig, deleteCloudflareDnsRecordsForProject, deleteCloudflareProjectResources, deleteTeamCapacityAggregate, derivePlatformOperationNavigation, deriveProjectHostBindingsView, domainInZone, encryptCredentialSessionPayload, encryptedHostPayloadLooksValid, enqueueTreeDxProvisionOperation, ensureCommerceStripeCustomer, ensureMarketCredentialSchema, ensurePrincipal, entitlementRenewalStateFromSubscription, enumValue, exchangeProviderIdentity, executeInline, executeProjectApi, executeSdkOperation, existsSync, exportSeedWithStore, exposeAuthTokenForTests, fallbackRemoteCapability, findById, findDispatchCapability, getSiteAuthConfig, getUserEmailAddress, githubOidcJwksCache, githubRequestForProjectDeletion, grantCommerceEntitlementsForOrder, handleCommerceInvoiceWebhook, handleCommercePaymentIntentWebhook, handleCommerceSubscriptionWebhook, hasRecordedCloudflareRuntimeResources, hashMarketPassword, hostBindingRequiresUnlock, hostKindForBinding, hubRepositoryPolicies, inferZoneNameForDomain, installApiRequestLogger, installCapacityRoutes, installProjectDeploymentRoutes, isLocalAcceptanceServicePrincipal, isLoopbackUrl, isPlatformOperationTerminal, isTeamApiPrincipal, isValidPersonalThemeDraft, jsonError, jsonThrownError, launchCapabilityPreset, launchPlannerRepositoryTopology, listCloudflareNamedResources, listManagedHostsFromConfig, listUserEmailAddresses, loadGitHubOidcJwks, loadInfrastructureSeedState, loadKnowledgeContentEntries, loadNotificationPreferences, loadProjectHostBindingContext, loadTemplateCatalog, localAcceptanceAdminToken, localAcceptanceAuthEnabled, localContentPath, localContentRoot, logRequests, managedCloudflareConfigMissing, markdownToPlainProjectSummary, marketAuthContext, marketEmailTokenHash, marketProfilesForTeams, mergeCapability, mergeStringConfig, mkdir, nonSecretLaunchJobInput, normalizeAppearancePreference, normalizeAuditHostKinds, normalizeBaseUrl, normalizeCheckoutQuantity, normalizeCiEnvironment, normalizeDomainName, normalizeEmail, normalizeLocalContentInput, normalizeMarketProfile, normalizeNotificationPreferences, normalizeProjectDomainInput, normalizeProjectLaunchHostBindings, normalizeProviderCredentialConfig, normalizeRelationArray, normalizeRepositoryContentInput, normalizeRepositoryRelationArray, normalizeRepositorySlug, normalizeSeedEnvironments, normalizeTemplateLaunchRequirements, normalizeTemplateId, normalizeUsername, normalizedCloudflareKvNamespaceReference, operationTokenSecret, optionalTrimmedString, orderStatusFromPaymentGroup, parseBase64urlJson, parseBooleanEnvValue, parseJsonObject, parseYaml, passwordResetUrlFor, patchLaunchIntentForCredentialOverlay, paymentGroupStatusFromPaymentIntent, pbkdf2Sync, persistProjectHostBindingOperationMetadata, personalThemeFromRow, plaintextHostCredentialFieldPaths, planKnowledgeHubLaunch, planProjectHostBindingOperation, planSeedWithStore, platformOperationMutationError, principalCanManageCommerceProduct, principalHasGlobalPlatformRole, principalHasPermission, principalIsSeedAdmin, privateKnowledgeAuditPayload, processCommerceStripeWebhook, projectAllowedCiRepositories, projectApiConnection, projectAppHref, projectDeletionBlockerRows, projectDeletionConfirmationMatches, projectDeletionHostname, projectDeletionOperation, projectHostBindingMetadata, projectHostResponsePayload, providerConfigFor, providerCredentialValuesForAudit, providerJwksCache, publicPaymentGroups, randomBytes, randomUUID, readCapacityRequestObject, readFile, readJsonOrFormBody, readLocalContentRecord, recordContentNotificationEvent, recordFeedbackSubmission, recordPrivateKnowledgeAudit, redactCommerceOwnershipWorkflow, redactCommerceServiceRequestForBuyer, redactedRequestTarget, refreshCommercePaymentGroupState, refreshCommerceStripeAccount, rejectPlaintextHostCredentialFields, rejectProjectSecretUnlockMaterial, relative, remainingRefundableAmount, repositoryContentRelationPolicy, repositoryInventoryWithPlatform, requestClientIp, requestSessionMetadata, requireCatalogItemAccess, requireCommerceCapacityInquiryAccess, requireCommerceCapacityListingAccess, requireCommerceOfferAccess, requireCommerceProductAccess, requireCommerceVendorForStripe, requireConfiguredServiceCredential, requireConnectedProjectRuntime, requirePlatformRunner, requireProjectAccess, requireProjectRunner, requireSeedApplyAccess, requireSeedPlanAccess, requireSellerTeamAccess, requireServiceBuyerAccess, requireServiceParticipantAccess, requireServiceSellerAccess, requireTeamAccess, requireVendorOrderManager, resolve, resolveAgentArtifactBucket, resolveAgentTaskSignature, resolveApiConfig, resolveAuthApprovalBaseUrl, resolveCloudflareZoneForLaunchPreflight, resolveCommerceCheckoutItem, resolveFulfillmentArtifact, resolveLaunchTemplateRequirements, resolveOrderItemForRefund, resolvePlatformRepositoryDescriptor, resolvePlatformRunnerSecret, resolveProjectDeletionCloudflareZone, resolveProjectLaunchHostBindings, resolvePublicTreeDxTeam, resolveStripeEnvironment, resolveStripePublishableKey, resolveStripeWebhookSecret, resolveManagedCloudflareHostConfigFromConfig, resolveUiProjectionContext, resourceRowsFromLaunch, retryApiLaunchBootstrapFromRequest, rm, runProjectDeletionApiDestroy, runProjectLaunchApiBootstrap, runHostingAudit, runtime, runtimeMarketAuthProvider, runtimeProviders, safeFeedbackClient, safeFeedbackContext, safeFeedbackScreenshot, safePlatformOperationOutput, safePrivateKnowledgeSlug, safeTokenEquals, sanitizeLaunchResultForStorage, sanitizedReturnTo, scheduleBackgroundBootstrap, seedActor, seedCreatesMissingTeams, seedExistingTeamIds, selectDispatchTarget, sendAuthEmail, sendEmailConfirmation, sendTeamInviteEmail, sendWelcomeEmail, serializeFrontmatter, serializeUserEmailAddress, setPrimaryEmailAddress, sharedSdk, shouldBypassAcceptanceAuthEmailDelivery, shouldExposeNonProductionAuthDiagnostics, shouldLogApiRequests, signEditorialPreviewToken, signOperationToken, slugifyContent, slugifyRepositoryContent, sourceFromProjectDetails, store, stripeAccountMissingError, stripeAccountToConnectedAccountPatch, stripeClientSecret, stripeCommerceUrl, stripeConfiguredError, stripeConnectService, stripeMetadataValue, stripePriceTermsDrift, stripeRefundStatus, stripeTimestampToIso, stripeVendorApprovalError, subscriptionClientSecret, subscriptionStatusFromStripe, syncCommerceOfferStripeProduct, syncCommercePriceStripePrice, syncCommerceSubscriptionFromStripe, syncPrimaryEmailCaches, teamInviteAcceptUrlFor, timingSafeEqual, trimmedHeaderValue, uiRuntimeLocals, uniqueCloudflareKvNamespaceReferences, uniqueRelationArray, unknownKeys, unwrapLaunchOperationOutput, unwrapOperationPayload, updateCheckoutCompletionFromGroup, updateLaunchDeployments, validateCiRefForEnvironment, validateFeedbackAccess, validateMarketPassword, validateProjectSlug, validatePublicUsername, validateTeamHostCredentialPayload, verifiedEmailCount, verifyCloudflareDnsWriteForLaunch, verifyGitHubOidcToken, verifyMarketPassword, verifyOperationToken, verifyProviderIdToken, webAuthPayload, webSessionData, writeFile, writeLocalContentRecord, writeParsedLocalContentRecord, yamlLines, yamlScalar } = context;
	const actorOwnsTeam = async (teamId: string, principal: any) => {
		const teamContext = await store.resolvePrincipalTeamContext(teamId, principal);
		return teamContext?.roles?.includes('team_owner') === true || principalHasGlobalPlatformRole(principal, 'site_admin');
	};
	const teamMutationStatus = (result: { ok?: boolean; code?: string } | null) => {
		if (!result) return 404;
		if (result.ok) return 200;
		if (result.code === 'missing') return 404;
		if (['stale', 'invite_already_pending', 'namespace_taken', 'taken'].includes(String(result.code))) return 409;
		return 400;
	};
	app.post('/v1/team-invites/:token/accept', async (c) => {
					const auth = await ensurePrincipal(c);
					if (auth.response) return auth.response;
					const result = await store.acceptTeamInvite(c.req.param('token'), auth.principal.id);
					if (result.ok) await store.recordAuditEvent({
						actorType: 'user', actorId: auth.principal.id, eventType: 'team.invitation.accepted',
						targetType: 'team', targetId: result.team?.id ?? result.invite?.teamId ?? null,
						data: { invitationId: result.invite?.id ?? null },
					});
					return c.json(result, result.ok ? 200 : 400);
				});
	
	app.get('/v1/team-invites/:token', async (c) => {
					const result = await store.getTeamInviteByToken(c.req.param('token'));
					if (!result.ok) return c.json(result, 404);
					return c.json({
						ok: true,
						payload: {
							invite: {
								id: result.invite.id,
								email: result.invite.email,
								roleKey: result.invite.roleKey,
								status: result.invite.status,
								expiresAt: result.invite.expiresAt,
							},
							team: result.team ? {
								id: result.team.id,
								name: result.team.name,
								displayName: result.team.displayName,
							} : null,
						},
					});
				});
	
	app.get('/v1/teams/:teamId/home', async (c) => {
					const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'projects:read:team');
					if (access.response) return access.response;
					return c.json({
						ok: true,
						payload: await store.getTeamHomeSummary(c.req.param('teamId'), access.principal, capacity),
					});
				});
	
	app.get('/v1/teams/:teamId/inbox', async (c) => {
					const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'projects:read:team');
					if (access.response) return access.response;
					return c.json({
						ok: true,
						payload: await store.listTeamInboxItems(c.req.param('teamId'), access.principal),
					});
				});
	
	app.get('/v1/teams/:teamId/approval-requests', async (c) => {
					const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'projects:read:team');
					if (access.response) return access.response;
					const limit = Number(c.req.query('limit') ?? 50);
					const kind = c.req.query('kind');
					return c.json({
						ok: true,
						payload: await store.listApprovalRequestsForTeam(c.req.param('teamId'), { kind, limit }),
					});
				});
	
	app.get('/v1/teams/:teamId/members', async (c) => {
					const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'projects:read:team');
					if (access.response) return access.response;
					const members = await store.listTeamMembers(c.req.param('teamId'));
					const query = String(c.req.query('q') ?? '').trim().toLowerCase();
					const ownerCount = members.filter((member) => member.roles?.includes('team_owner')).length;
					const filtered = query
						? members.filter((member) => `${member.displayName ?? ''} ${member.email ?? ''} ${member.roleKey ?? ''}`.toLowerCase().includes(query))
						: members;
					if (c.req.query('page') || c.req.query('limit') || query) {
						const limit = Math.min(100, Math.max(1, Number(c.req.query('limit') ?? 25)));
						const page = Math.max(1, Number(c.req.query('page') ?? 1));
						const offset = (page - 1) * limit;
						return c.json({ ok: true, payload: { items: filtered.slice(offset, offset + limit), page, limit, total: filtered.length, ownerCount } });
					}
					return c.json({
						ok: true,
						payload: members,
						ownerCount,
					});
				});
	
	app.get('/v1/teams/:teamId/permissions', async (c) => {
					const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'projects:read:team');
					if (access.response) return access.response;
					return c.json({
						ok: true,
						payload: await store.getTeamAccessSummary(c.req.param('teamId'), access.principal),
					});
				});
	
	app.get('/v1/teams/:teamId/products', async (c) => {
					const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'projects:read:team');
					if (access.response) return access.response;
					return c.json({
						ok: true,
						payload: await store.listTeamProducts(c.req.param('teamId'), access.principal),
					});
				});
	
	app.post('/v1/teams/:teamId/seeds/export', async (c) => {
					const body = await c.req.json().catch(() => ({}));
					const includePrivate = body.includePrivate === true;
					const access = await requireTeamAccess(c, store, c.req.param('teamId'), includePrivate ? 'teams:manage:team' : 'projects:read:team');
					if (access.response) return access.response;
					const result = await exportSeedWithStore({
						store,
						teamId: c.req.param('teamId'),
						name: typeof body.name === 'string' && body.name.trim() ? body.name.trim() : 'exported',
						environments: normalizeSeedEnvironments(body.environments),
						includePrivate,
						includeArtifacts: body.includeArtifacts === true,
						principal: access.principal,
					});
					return c.json(result, result.ok ? 200 : 400);
				});
	
	app.post('/v1/teams', async (c) => {
					const auth = await ensurePrincipal(c);
					if (auth.response) return auth.response;
					const localAcceptanceService = isLocalAcceptanceServicePrincipal(c, auth.principal);
					if ((isTeamApiPrincipal(auth.principal) && !localAcceptanceService) || c.get('actorType') === 'project') {
						return jsonError(c, 403, 'Permission denied.');
					}
					if (!localAcceptanceService && await verifiedEmailCount(store, auth.principal.id) < 1) {
						return jsonError(c, 403, 'Verify an email address before creating a team.', { code: 'verified_email_required' });
					}
					const body = await c.req.json().catch(() => ({}));
					if (!body.name && !body.slug) {
						return jsonError(c, 400, 'name is required.');
					}
					let team;
					try {
						team = await store.createTeam({
							name: String(body.slug ?? body.name),
							displayName: typeof body.displayName === 'string' ? body.displayName : typeof body.label === 'string' ? body.label : String(body.name ?? body.slug),
							logoUrl: typeof body.logoUrl === 'string' ? body.logoUrl : null,
							profileSummary: typeof body.profileSummary === 'string' ? body.profileSummary : typeof body.description === 'string' ? body.description : null,
							metadata: typeof body.metadata === 'object' && body.metadata ? body.metadata : {},
							ownerUserId: !localAcceptanceService && typeof auth.principal.id === 'string' ? auth.principal.id : null,
						});
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						const status = /already taken|already used/u.test(message) ? 409 : 400;
						return jsonError(c, status, message, {
							code: status === 409 ? 'namespace_taken' : 'invalid_team',
							fieldErrors: { name: message },
						});
					}
					await store.recordAuditEvent({
						actorType: 'user', actorId: auth.principal.id, eventType: 'team.created',
						targetType: 'team', targetId: team.id, data: { name: team.name },
					});
					return c.json({ ok: true, payload: team });
				});
	
	app.patch('/v1/teams/:teamId', async (c) => {
					const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'teams:manage:team');
					if (access.response) return access.response;
					const existingTeam = await store.getTeam(c.req.param('teamId'));
					if (existingTeam?.status === 'archived') return jsonError(c, 409, 'Archived teams are read-only.', { code: 'team_archived' });
					const body = await c.req.json().catch(() => ({}));
					const result = await store.updateTeamSettings(c.req.param('teamId'), {
							name: typeof body.name === 'string' ? body.name : undefined,
							displayName: typeof body.displayName === 'string' ? body.displayName : undefined,
							logoUrl: typeof body.logoUrl === 'string' ? body.logoUrl : undefined,
							profileSummary: typeof body.profileSummary === 'string' ? body.profileSummary : typeof body.description === 'string' ? body.description : undefined,
							metadata: typeof body.metadata === 'object' && body.metadata ? body.metadata : {},
							expectedUpdatedAt: typeof body.expectedUpdatedAt === 'string' ? body.expectedUpdatedAt : undefined,
						});
					if (!result) return jsonError(c, 404, 'Team not found.', { code: 'team_missing' });
					if (result.ok) {
						const fields = [
							{ field: 'name', label: 'Team address', before: existingTeam?.name, after: result.team?.name },
							{ field: 'displayName', label: 'Display name', before: existingTeam?.displayName, after: result.team?.displayName },
							{ field: 'logoUrl', label: 'Logo', before: existingTeam?.logoUrl, after: result.team?.logoUrl },
							{ field: 'profileSummary', label: 'Profile summary', before: existingTeam?.profileSummary, after: result.team?.profileSummary },
							{ field: 'visibility', label: 'Visibility', before: existingTeam?.metadata?.visibility, after: result.team?.metadata?.visibility },
						].filter((change) => change.before !== change.after);
						await store.recordAuditEvent({
							actorType: 'user', actorId: access.principal.id, eventType: 'team.updated',
							targetType: 'team', targetId: c.req.param('teamId'),
							data: { changes: fields },
						});
					}
					return c.json({ ...result }, teamMutationStatus(result));
				});
	
	app.post('/v1/teams/:teamId/invites', async (c) => {
					const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'teams:manage:team');
					if (access.response) return access.response;
					if ((await store.getTeam(c.req.param('teamId')))?.status === 'archived') return jsonError(c, 409, 'Archived teams are read-only.', { code: 'team_archived' });
					const body = await c.req.json().catch(() => ({}));
					const result = await store.createTeamInvite(c.req.param('teamId'), {
						email: body.email,
						roleKey: body.roleKey ?? body.role,
						invitedByUserId: access.principal.id,
					});
					if (result.ok && result.invite && result.token) {
						try {
							if (!shouldBypassAcceptanceAuthEmailDelivery(c, runtime.resolved.config)) {
								const team = await store.getTeam(c.req.param('teamId'));
								await sendTeamInviteEmail(marketAuthContext(c, config), {
									invite: result.invite,
									team,
									token: result.token,
								});
							}
						} catch (error) {
							console.warn('[team-invite] Email delivery failed:', error instanceof Error ? error.message : String(error));
							await store.revokeTeamInvite(c.req.param('teamId'), result.invite.id);
							const reason = authEmailDeliveryFailureReason(error);
							return jsonError(c, 503, 'Team invite email could not be sent. Please try again shortly.', {
								code: 'team_invite_delivery_failed',
								reason,
								...(shouldExposeNonProductionAuthDiagnostics(c, runtime) ? { detail: authEmailDeliveryFailureDetail(error) } : {}),
							});
						}
						await store.recordAuditEvent({
							actorType: 'user', actorId: access.principal.id, eventType: 'team.invitation.created',
							targetType: 'team', targetId: c.req.param('teamId'),
							data: {
								invitationId: result.invite.id,
								recipientEmail: result.invite.email,
								roleKey: result.invite.roleKey,
							},
						});
					}
					return c.json(result, teamMutationStatus(result));
				});
	
	app.patch('/v1/teams/:teamId/members/:membershipId', async (c) => {
					const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'teams:manage:team');
					if (access.response) return access.response;
					if ((await store.getTeam(c.req.param('teamId')))?.status === 'archived') return jsonError(c, 409, 'Archived teams are read-only.', { code: 'team_archived' });
					const body = await c.req.json().catch(() => ({}));
					const requestedRole = String(body.roleKey ?? body.role ?? 'contributor');
					const members = await store.listTeamMembers(c.req.param('teamId'));
					const targetMember = members.find((member) => member.id === c.req.param('membershipId'));
					const targetRoles = await store.listRoleKeysForMembership(c.req.param('membershipId'));
					if ((requestedRole === 'team_owner' || targetRoles.includes('team_owner'))
						&& !await actorOwnsTeam(c.req.param('teamId'), access.principal)) {
						return jsonError(c, 403, 'Only team owners can grant or remove ownership.', { code: 'owner_required' });
					}
					const result = await store.updateTeamMemberRole(
						c.req.param('teamId'),
						c.req.param('membershipId'),
						requestedRole,
						typeof body.expectedVersion === 'string' ? body.expectedVersion : undefined,
					);
					if (result.ok) await store.recordAuditEvent({
						actorType: 'user', actorId: access.principal.id, eventType: 'team.member.role_changed',
						targetType: 'team', targetId: c.req.param('teamId'),
						data: {
							membershipId: c.req.param('membershipId'),
							subjectDisplayName: targetMember?.displayName,
							subjectEmail: targetMember?.email,
							previousRoleKey: targetMember?.roleKey,
							roleKey: requestedRole,
						},
					});
					return c.json(result, teamMutationStatus(result));
				});

	app.get('/v1/teams/:teamId/members/:membershipId/removal-blockers', async (c) => {
					const teamId = c.req.param('teamId');
					const membershipId = c.req.param('membershipId');
					const access = await requireTeamAccess(c, store, teamId, 'teams:manage:team');
					if (access.response) return access.response;
					const members = await store.listTeamMembers(teamId);
					const target = members.find((member) => member.id === membershipId);
					if (!target) return jsonError(c, 404, 'Team member not found.', { code: 'member_missing' });
					const targetIsOwner = target.roles?.includes('team_owner') === true;
					const actorIsOwner = await actorOwnsTeam(teamId, access.principal);
					const ownerCount = members.filter((member) => member.roles?.includes('team_owner')).length;
					const blockers = [
						...(targetIsOwner && !actorIsOwner ? [{
							code: 'owner_required',
							label: 'Only a team owner can remove another owner.',
							href: `/app/teams/${encodeURIComponent(teamId)}/members`,
						}] : []),
						...(targetIsOwner && ownerCount <= 1 ? [{
							code: 'last_owner',
							label: 'Transfer ownership or add another owner before removal.',
							href: `/app/teams/${encodeURIComponent(teamId)}/members`,
						}] : []),
					];
					return c.json({ ok: true, payload: { membershipId, eligible: blockers.length === 0, blockers } });
				});
	
	app.delete('/v1/teams/:teamId/members/:membershipId', async (c) => {
					const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'teams:manage:team');
					if (access.response) return access.response;
					if ((await store.getTeam(c.req.param('teamId')))?.status === 'archived') return jsonError(c, 409, 'Archived teams are read-only.', { code: 'team_archived' });
					const body = await c.req.json().catch(() => ({}));
					const members = await store.listTeamMembers(c.req.param('teamId'));
					const targetMember = members.find((member) => member.id === c.req.param('membershipId'));
					const targetRoles = await store.listRoleKeysForMembership(c.req.param('membershipId'));
					if (targetRoles.includes('team_owner') && !await actorOwnsTeam(c.req.param('teamId'), access.principal)) {
						return jsonError(c, 403, 'Only team owners can remove an owner.', { code: 'owner_required' });
					}
					const result = await store.removeTeamMember(
						c.req.param('teamId'),
						c.req.param('membershipId'),
						typeof body.expectedVersion === 'string' ? body.expectedVersion : undefined,
					);
					if (result.ok) await store.recordAuditEvent({
						actorType: 'user', actorId: access.principal.id, eventType: 'team.member.removed',
						targetType: 'team', targetId: c.req.param('teamId'),
						data: {
							membershipId: c.req.param('membershipId'),
							subjectDisplayName: targetMember?.displayName,
							subjectEmail: targetMember?.email,
							roleKey: targetMember?.roleKey,
						},
					});
					return c.json(result, teamMutationStatus(result));
				});
	
	app.get('/v1/teams/:teamId/deletion-blockers', async (c) => {
					const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'teams:manage:team');
					if (access.response) return access.response;
					return c.json({ ok: true, payload: await store.evaluateTeamDeletionBlockers(c.req.param('teamId')) });
				});
	
	app.post('/v1/teams/:teamId/api-keys', async (c) => {
					const access = await requireTeamAccess(c, store, c.req.param('teamId'), 'teams:manage:team');
					if (access.response) return access.response;
					const body = await c.req.json().catch(() => ({}));
					if (!body.name) {
						return jsonError(c, 400, 'name is required.');
					}
					return c.json({
						ok: true,
						payload: await store.createTeamApiKey(c.req.param('teamId'), {
							name: String(body.name),
							permissions: Array.isArray(body.permissions) ? body.permissions.map(String) : [],
							expiresAt: typeof body.expiresAt === 'string' ? body.expiresAt : null,
						}),
					});
				});
}
