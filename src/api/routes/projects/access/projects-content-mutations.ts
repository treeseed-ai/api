export function installProjectsContentMutationRoutes(context: any) {
	const { PROPOSAL_VERDICT_DECISION_TYPES, app, decoratePlatformOperation, enumValue, isTeamApiPrincipal, jsonError, normalizeRepositoryContentInput, normalizeRepositoryRelationArray, optionalTrimmedString, readJsonOrFormBody, repositoryContentRelationPolicy, requireProjectAccess, resolvePlatformRepositoryDescriptor, runtime, slugifyRepositoryContent, store } = context;
	
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
}
