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
	const { app, capacity, config, createHash, createMarketWebSession, ensureMarketCredentialSchema, hashMarketPassword, normalizeEmail, normalizeUsername, optionalTrimmedString, randomUUID, requireConfiguredServiceCredential, resolve, resolvePlatformRunnerSecret, runtime, runtimeControlPlaneAuthProvider, store } = context;
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
							synced = await runtimeControlPlaneAuthProvider.syncUserIdentity({
								provider: 'acceptance', providerSubject: `${namespace}:${actorId}`, email, emailVerified: true, username, displayName,
								profile: { acceptance: true, namespace, actorId },
							});
						}
						if (runtimeControlPlaneAuthProvider.setUserRoles) {
							await runtimeControlPlaneAuthProvider.setUserRoles(synced.principal.id, Array.isArray(actorInput.siteRoles) ? actorInput.siteRoles.map(String) : ['viewer']);
						}
						const now = new Date().toISOString();
						await store.run(`DELETE FROM control_plane_auth_credentials WHERE user_id = ? OR email = ? OR username = ?`, [synced.principal.id, email, username]);
						await store.run(
							`INSERT INTO control_plane_auth_credentials (user_id, email, username, password_hash, status, created_at, updated_at)
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
						const session = await createMarketWebSession(runtimeControlPlaneAuthProvider, synced.principal.id, {
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
							metadata: { acceptance: true, namespace, visibility: 'public' },
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
						const projectTreeDxLibrary = await store.upsertProjectTreeDxLibrary(project.id, {
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
						metadata: { acceptance: true, namespace },
					}).catch(() => null);
					const agentClassId = `${project.id}:visual-audit`;
					const agentClass = await capacity.getProjectAgentClass(project.id, agentClassId)
						?? await capacity.createProjectAgentClass(project.id, {
							id: agentClassId,
							slug: 'visual-audit',
							name: 'Visual Audit Agent',
							status: 'active',
							allowedModes: ['planning'],
							requiredCapabilities: [],
							handlerRefs: {
								agents: [{
									slug: 'visual-audit-agent',
									name: 'Visual Audit Agent',
									groupIds: [],
									contentPath: 'src/content/agents/visual-audit-agent.mdx',
									enabled: true,
									activities: {
										planning: {
											handler: 'writer',
											purpose: 'Keep the authenticated Agent Lab acceptance surface visibly inspectable.',
											planningPriority: 1,
										},
									},
								}],
								signalContracts: {},
								proposalTypeContracts: {},
								groupContracts: {},
								groupEdgeContracts: {},
							},
							metadata: { acceptance: true, namespace, immutableRef: `acceptance:${namespace}` },
						}, `acceptance-${namespace}-agent-class`);
					const workdayRunId = `workday-run-${namespace}`.replace(/[^a-z0-9-]+/giu, '-').slice(0, 96);
					const workdayRun = await capacity.getCapacityWorkdayRun(team.id, workdayRunId)
						?? await capacity.createCapacityWorkdayRun(team.id, {
							id: workdayRunId,
							scenarioId: 'Acceptance Atlas readiness',
							status: 'queued',
							environment: 'local',
							parameters: { acceptance: true, namespace, durationSeconds: 0 },
						});
					const workdayEventId = `event-${namespace}-atlas-ready`.replace(/[^a-z0-9-]+/giu, '-').slice(0, 96);
					const existingWorkdayEvent = await store.first(`SELECT id FROM capacity_workday_events WHERE id = ? LIMIT 1`, [workdayEventId]).catch(() => null);
					const workdayEvent = existingWorkdayEvent ?? await capacity.createCapacityWorkdayEvent(team.id, workdayRunId, {
						id: workdayEventId,
						projectId: project.id,
						eventType: 'acceptance.atlas.ready',
						status: 'recorded',
						title: 'Acceptance agent topology ready',
						message: 'A validated project agent definition is available for Atlas inspection.',
						metadata: { acceptance: true, namespace, agentId: 'visual-audit-agent' },
					});
					for (let index = 1; index <= 26; index += 1) {
						const suffix = String(index).padStart(2, '0');
						const eventId = `event-${namespace}-forensic-${suffix}`.replace(/[^a-z0-9-]+/giu, '-').slice(0, 96);
						const existing = await store.first(`SELECT id FROM capacity_workday_events WHERE id = ? LIMIT 1`, [eventId]).catch(() => null);
						if (existing) continue;
						await capacity.createCapacityWorkdayEvent(team.id, workdayRunId, {
							id: eventId,
							projectId: project.id,
							eventType: 'acceptance.atlas.forensic',
							status: 'recorded',
							title: `Acceptance forensic event ${suffix}`,
							message: `Acceptance forensic event ${suffix} is available for filter and paging verification.`,
							metadata: { acceptance: true, namespace, sequence: index },
						});
					}
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
					const proposalId = `proposal-${namespace}`.replace(/[^a-z0-9-]+/giu, '-').slice(0, 96);
					const proposal = await store.createGovernanceProposal(null, {
						id: proposalId,
						teamId: team.id,
						projectId: project.id,
						scope: 'project',
						title: 'Acceptance assignment graph',
						summary: 'Authoritative accepted proposal for assignment graph acceptance.',
						body: 'Compile and verify a bounded assignment graph through the normal governance path.',
						proposalType: 'implementation',
						createdByType: 'service',
						createdById: 'acceptance',
						metadata: { acceptance: true, namespace },
					});
					await store.transitionGovernanceProposal(proposal!.id, 'accepted', {
						actorType: 'service', actorId: 'acceptance', reason: 'Acceptance fixture decision authority.',
					});
					const governanceDecision = await store.createGovernanceDecisionFromProposal(proposal!.id, {
						actorType: 'service', actorId: 'acceptance', outcome: { voteResult: { acceptance: true } },
					});
					const decisionId = governanceDecision!.id;
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
						`INSERT INTO control_plane_auth_password_resets (id, user_id, token_hash, expires_at, used_at, created_at)
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
									projectTreeDxLibrary: {
										instanceId: projectTreeDxLibrary?.instanceId ?? null,
										libraryId: projectTreeDxLibrary?.libraryId ?? null,
										repositoryId: projectTreeDxLibrary?.repositoryId ?? null,
									},
									treeDx: { id: treeDx?.instance?.id ?? null, mirrorCount: treeDx?.mirrors?.length ?? 0 },
								membership: { id: ownerMembership?.id ?? null },
								memberships: membershipFixtures,
								session: { id: actors.teamOwner?.sessionId ?? actors.siteAdmin?.sessionId ?? null },
								workday: { id: workday?.id ?? `workday-${namespace}` },
								agentClass: { id: agentClass?.id ?? agentClassId },
								workdayRun: { id: workdayRun?.id ?? workdayRunId },
								workdayEvent: { id: workdayEvent?.id ?? workdayEventId },
								job: { id: operation?.id ?? `operation-${namespace}` },
								platformOperation: { id: operation?.id ?? `operation-${namespace}` },
								platformRunner: { id: platformRunner?.id ?? platformRunnerId },
								seedRun: { id: seedRun?.id ?? `seed-${namespace}` },
								invite: { id: invite?.invite?.id ?? null },
								approvalRequest: { id: approvalRequest?.id ?? `approval-${namespace}` },
								decision: { id: decisionPlanningStatus?.decisionId ?? decisionId },
								passwordReset: { token: resetToken },
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
