export function installTreedxInternalTreedxPublicFederationStatusRoutes(context: any) {
	const { app, config, optionalTrimmedString, requireConfiguredServiceCredential, runtime, store } = context;
	app.get('/v1/internal/treedx/public-federation/status', async (c) => {
					const service = requireConfiguredServiceCredential(c, runtime.resolved.config);
					if (service.response) return service.response;
					const teamId = optionalTrimmedString(c.req.query('teamId'));
					const teamSlug = optionalTrimmedString(c.req.query('teamSlug')) ?? optionalTrimmedString(c.req.query('slug')) ?? 'treeseed-public';
					const team = teamId
						? await store.getTeam(teamId).catch(() => null)
						: await store.getTeamBySlug(teamSlug).catch(() => null);
					if (!team) return c.json({ ok: true, payload: { team: null, instance: null, deployments: [] } });
					const payload = await store.getTeamTreeDx(team.id);
					const deployments = Array.isArray(payload.deployments) && payload.deployments.length > 0
						? payload.deployments
						: await store.listTreeDxDeployments(team.id).catch(() => []);
					return c.json({ ok: true, payload: { ...payload, deployments, team } });
				});
}
