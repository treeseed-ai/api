export async function prepareProjectLaunch(context: any, state: any) {
	const { store, planKnowledgeHubLaunch, launchCapabilityPreset, hubRepositoryPolicies } = context;
	const {
		body, details, hostingKind, hostingMode, projectDomains, repoProvider, repoVisibility,
		sourceKind, sourceRef, hostMetadata, hostBindingMetadata, teamId, team,
		requestedCoreObjective, sourceVersion, repositoryHost, requestedRepository,
		cloudflareHostMetadata, emailHostMetadata, hostBindingResolution,
		cloudflareHostMode, cloudflareHostId, emailHostMode, emailHostId,
		cloudflareHost, cloudflareLaunchConfig, launchRepositoryTopology, canonicalIntent, runtime,
		targetEnvironments,
	} = state;
					for (const environment of ['local', 'staging', 'prod']) {
						const domain = environment === 'prod'
							? projectDomains.productionDomain
							: environment === 'staging'
								? projectDomains.stagingDomain
								: null;
						await store.upsertProjectEnvironment(details.project.id, {
							environment,
							deploymentProfile: hostingKind,
							baseUrl: domain ? `https://${domain}` : null,
							cloudflareAccountId: cloudflareHostMode === 'team_owned'
								? cloudflareHost?.metadata?.cloudflareAccountId ?? null
								: cloudflareLaunchConfig?.CLOUDFLARE_ACCOUNT_ID ?? null,
							metadata: {
								launchMode: hostingMode,
								launchPhase: 'queued',
								...(domain ? {
									domain,
									dnsManagedByHost: projectDomains.manageDns,
									cloudflareZoneName: projectDomains.zoneName,
									cloudflareZoneId: projectDomains.zoneId,
								} : {}),
							},
						});
					}
					const launchIntent = {
						team: {
							id: teamId,
							slug: team?.slug ?? team?.name ?? null,
						},
						hub: {
							id: details.project.id,
							name: details.project.name,
							slug: details.project.slug,
							purpose: details.project.description ?? null,
							coreObjective: requestedCoreObjective,
							visibility: body.publicSite === false ? 'team' : 'public',
						},
						source: {
							kind: sourceKind === 'blank' ? 'blank_hub' : sourceKind,
							ref: sourceRef,
							version: sourceVersion,
						},
						repository: {
							hostId: repositoryHost.id,
							provider: 'github',
							owner: repositoryHost.organizationOrOwner,
							topology: launchRepositoryTopology,
							visibility: repoVisibility,
							softwareRepository: requestedRepository?.softwareRepository ?? null,
							contentRepository: requestedRepository?.contentRepository ?? null,
						},
						hosting: {
								mode: 'treeseed_managed',
								webHost: cloudflareHostMetadata,
								emailHost: emailHostMetadata,
								domains: projectDomains,
								hostBindings: hostBindingResolution.hostBindings,
							},
						contentResolution: {
							productionSource: 'r2_published_artifacts',
							overlaySource: 'src_content_when_present',
							localSource: 'local_content_checkout',
							fallback: 'empty_with_diagnostics',
						},
						direction: canonicalIntent?.direction && typeof canonicalIntent.direction === 'object' ? canonicalIntent.direction : {
							objective: typeof body.objective === 'string' ? body.objective : null,
							question: typeof body.question === 'string' ? body.question : null,
							proposal: typeof body.proposal === 'string' ? body.proposal : null,
							decisionPolicyPreset: typeof body.decisionPolicyPreset === 'string' ? body.decisionPolicyPreset : 'lead_approval',
						},
						capabilities: Array.isArray(canonicalIntent?.capabilities) ? canonicalIntent.capabilities : [],
						market: canonicalIntent?.market && typeof canonicalIntent.market === 'object' ? canonicalIntent.market : {},
						execution: {
							providerLaunchInput: {
								projectId: details.project.id,
								teamId,
								teamSlug: team?.slug ?? team?.name ?? null,
								projectSlug: details.project.slug,
								projectName: details.project.name,
								summary: details.project.description ?? null,
								coreObjective: requestedCoreObjective,
								sourceKind: sourceKind === 'blank_hub' ? 'blank' : sourceKind === 'market_listing' ? 'template' : sourceKind,
								sourceRef,
								hostingMode,
								publicSite: body.publicSite !== false,
								repoOwner: repositoryHost.organizationOrOwner,
								repoVisibility,
								marketBaseUrl: runtime.resolved.config.baseUrl ?? null,
								projectApiBaseUrl: typeof body.projectApiBaseUrl === 'string' ? body.projectApiBaseUrl : null,
								domains: projectDomains,
								contactEmail: typeof body.contactEmail === 'string' ? body.contactEmail : null,
								enableDefaultAgents: body.enableDefaultAgents !== false,
								hostBindings: hostBindingResolution.hostBindings,
								hostBindingPlans: hostBindingMetadata.hostBindingPlans,
									cloudflareHost: cloudflareHostMode
										? {
											mode: cloudflareHostMode,
										hostId: cloudflareHostId,
										targetEnvironments,
										}
										: null,
									emailHost: emailHostMode
										? {
										mode: emailHostMode,
										hostId: emailHostId,
										targetEnvironments,
									}
									: null,
							},
						},
					};
					const launchPlan = planKnowledgeHubLaunch(launchIntent, repositoryHost);
					await store.replaceProjectCapabilities(details.project.id, launchCapabilityPreset(launchPlan.repository.topology));
					for (const repository of launchPlan.repository.repositories) {
						await store.upsertHubRepository(details.project.id, {
							teamId,
							role: repository.role,
							repositoryHostId: repositoryHost.id,
							provider: 'github',
							owner: repository.owner,
							name: repository.name,
							url: repository.url ?? null,
							defaultBranch: repository.defaultBranch ?? 'main',
							currentBranch: repository.defaultBranch ?? 'main',
							status: 'queued',
							...hubRepositoryPolicies(repository.role),
							metadata: {
								topology: launchPlan.repository.topology,
								create: repository.create,
							},
						});
					}
					const contentRepository = (await store.listHubRepositories(details.project.id)).find((repository) => repository.role === 'content') ?? null;
					await store.upsertHubContentSource(details.project.id, {
						teamId,
						contentRepositoryId: contentRepository?.id ?? null,
						productionSource: 'r2_published_artifacts',
						overlayPolicy: 'src_content_when_present',
						metadata: {
							localSource: 'local_content_checkout',
							fallback: 'empty_with_diagnostics',
						},
					});

	return { launchIntent, launchPlan };
}

export async function completeProjectLaunch(context: any, state: any) {
	const {
		store, nonSecretLaunchJobInput, decorateJob, normalizeBaseUrl, scheduleBackgroundBootstrap,
		runProjectLaunchApiBootstrap,
	} = context;
	const {
		c, body, details, access, teamId, launchIntent, launchPlan, repositoryHost,
		hostBindingResolution, hostBindingMetadata, hostingMode, projectDomains, sourceRef,
		repoVisibility, cloudflareHostMode, cloudflareHostId, emailHostMode, emailHostId,
		runtime, cloudflareLaunchConfig, cloudflareHost, emailHost, auditHostKinds,
	} = state;
					const launchJob = await store.createJob({
						id: typeof body.launchRequestId === 'string' && body.launchRequestId.trim() ? body.launchRequestId.trim() : undefined,
						projectId: details.project.id,
						namespace: 'workflow',
						operation: 'launch_project',
						status: 'running',
						preferredMode: 'auto',
						selectedTarget: 'api',
						requestedByType: c.get('actorType') === 'service' ? 'service' : 'user',
						requestedById: typeof access.principal.id === 'string' ? access.principal.id : null,
						idempotencyKey: `launch:${details.project.id}`,
						input: nonSecretLaunchJobInput({
							teamId,
							projectId: details.project.id,
							launchIntent,
							launchPlan,
							repositoryHostId: repositoryHost.id,
							hostBindings: hostBindingResolution.hostBindings,
							hostBindingPlans: hostBindingMetadata.hostBindingPlans,
							hostingMode,
							bootstrap: {
								ownedBy: 'api',
								requiresPassphrase: false,
							},
						}),
					});
					const launchDeployments = [];
					for (const environment of ['staging', 'prod']) {
						const domain = environment === 'prod' ? projectDomains.productionDomain : projectDomains.stagingDomain;
						const deployment = await store.createProjectDeployment(details.project.id, {
							teamId,
							environment,
							deploymentKind: 'mixed',
							action: 'launch_project',
							status: 'running',
							platformOperationId: launchJob.id,
							idempotencyKey: `launch:${launchJob.id}:${environment}`,
							requestedByUserId: typeof access.principal.id === 'string' ? access.principal.id : null,
							sourceRef,
							triggeredByType: c.get('actorType') === 'service' ? 'service' : 'user',
							triggeredById: typeof access.principal.id === 'string' ? access.principal.id : null,
							repository: {
								provider: 'github',
								hostId: repositoryHost.id,
								owner: repositoryHost.organizationOrOwner,
								visibility: repoVisibility,
								topology: launchPlan.repository.topology,
								repositories: launchPlan.repository.repositories,
							},
							target: {
								provider: 'cloudflare',
								environment,
								domain,
								hostMode: cloudflareHostMode,
								hostId: cloudflareHostId,
								emailHostMode,
								emailHostId,
							},
							summary: `Started initial ${environment} project launch.`,
							metadata: {
								launchId: null,
								launchJobId: launchJob.id,
								launchRequestId: body.launchRequestId ?? null,
								launchPhase: 'credential_bootstrap',
								domains: projectDomains,
								...hostBindingMetadata,
							},
						});
						launchDeployments.push(deployment);
					}
					const hubLaunch = await store.createHubLaunch({
						hubId: details.project.id,
						teamId,
						jobId: launchJob.id,
						intent: launchIntent,
						plan: launchPlan,
						state: 'running',
						currentPhase: 'credential_bootstrap',
					});
					for (const deployment of launchDeployments) {
						await store.updateProjectDeployment(deployment.id, {
							metadata: {
								...(deployment.metadata ?? {}),
								launchId: hubLaunch.id,
							},
						});
						await store.appendProjectDeploymentEvent(deployment.id, {
							kind: 'launch.deployment_created',
							message: 'Durable deployment record created. Credential bootstrap is starting.',
							status: 'running',
							operationId: launchJob.id,
							payload: { launchId: hubLaunch.id },
						});
					}
					await store.appendHubLaunchEvent(hubLaunch.id, {
						phase: 'credential_bootstrap',
						status: 'running',
						title: 'Credential bootstrap',
						summary: 'TreeSeed created the durable launch record and started API-owned credential bootstrap.',
						data: { jobId: launchJob.id },
					});
					await store.appendJobEvent(launchJob.id, 'phase', {
						phase: 'credential_bootstrap',
						status: 'running',
						title: 'Credential bootstrap',
						summary: 'TreeSeed started API-owned credential bootstrap.',
					});
					const canonicalDeployment = launchDeployments.find((deployment) => deployment.environment === 'staging') ?? launchDeployments[0];
					const deploymentHref = `/app/projects/deployment/${encodeURIComponent(canonicalDeployment.id)}`;
					scheduleBackgroundBootstrap(c, () => runProjectLaunchApiBootstrap({
						store,
						runtime,
						jobId: launchJob.id,
						launchIntent,
						passphrase: null,
						repositoryHost,
						cloudflareHost,
						emailHost,
						cloudflareHostMode,
						emailHostMode,
						cloudflareLaunchConfig,
						auditHostKinds,
						principal: { id: access.principal.id, type: c.get('actorType') === 'service' ? 'service' : 'user' },
					}));
	
					const projectSummary = await store.getProjectSummary(details.project.id, access.principal);
					if (projectSummary) {
						await store.upsertProjectSummarySnapshot(details.project.id, teamId, projectSummary);
					}
					return c.json({
						ok: true,
						projectId: details.project.id,
						launchId: hubLaunch.id,
						operationId: launchJob.id,
						deploymentId: canonicalDeployment.id,
						deploymentHref,
						payload: {
							project: projectSummary ?? await store.getProjectDetails(details.project.id),
							launchJob: decorateJob(normalizeBaseUrl(runtime.resolved.config.baseUrl ?? ''), launchJob),
							launch: hubLaunch,
							deployments: await store.listProjectDeployments(details.project.id, { limit: 10 }),
							next: deploymentHref,
						},
					}, 202);
	
}
