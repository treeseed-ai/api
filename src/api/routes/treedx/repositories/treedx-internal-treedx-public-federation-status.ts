import { listUnpublishedTreeDxAuthoringState } from '../../../capacity/services/treedx/repositories/treedx-authoring-journal.ts';

export function installTreedxInternalTreedxPublicFederationStatusRoutes(context: any) {
	const { app, config, optionalTrimmedString, requireConfiguredServiceCredential, requirePlatformRunner, runtime, store } = context;
	app.get('/v1/internal/treedx/authoring-journal/status', async (c) => {
		const access = await requirePlatformRunner(c,runtime.resolved.config);
		if (access.response) return access.response;
		const teamSlug = optionalTrimmedString(c.req.query('teamSlug'));
		const projectSlug = optionalTrimmedString(c.req.query('projectSlug'));
		if (!teamSlug || !projectSlug) return c.json({ ok:false,code:'treedx_authoring_identity_required',error:'teamSlug and projectSlug are required.' },422);
		const project = await store.first(`SELECT project.id FROM projects project JOIN teams team ON team.id = project.team_id
			WHERE team.slug = ? AND project.slug = ? LIMIT 1`,[teamSlug,projectSlug]);
		if (!project) return c.json({ ok:true,payload:{ project:null,unpublished:[] } });
		const unpublished = await listUnpublishedTreeDxAuthoringState(store, String(project.id));
		c.header('cache-control','private, no-store');
		return c.json({ ok:true,payload:{ project:{ id:project.id,teamSlug,projectSlug },unpublished } });
	});
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
