import { createKnowledgePublicationStorage } from '../../knowledge/publication-storage.ts';
import { installEditorialReviewRoutes } from './editorial-review.ts';

export function installKnowledgePublicationRoutes(context: any) {
	installEditorialReviewRoutes(context);
	const { app, jsonError, store } = context;
	const storage = () => createKnowledgePublicationStorage({ adapter: context.options?.knowledgePublicationStorage,
		environment: context.options?.environment });

	app.get('/v1/teams/:teamId/knowledge/publication-status', async (c: any) => {
		const teamId = c.req.param('teamId');
		const access = await context.requireTeamAccess(c, store, teamId, 'knowledge:read');
		if (access.response) return access.response;
		let manifest;
		try { manifest = await storage().readCurrent(teamId); }
		catch { return jsonError(c, 503, 'Knowledge publication status is unavailable.', { code: 'knowledge_publication_unavailable' }); }
		const attempts = await store.all(`SELECT publications.id, publications.project_id, publications.commit_sha,
			publications.published_ref, publications.published_revision, publications.status,
			publications.created_at, publications.completed_at
			FROM knowledge_publications publications
			INNER JOIN knowledge_authoring_workspaces workspaces ON workspaces.id = publications.workspace_id
			WHERE workspaces.team_id = ? ORDER BY publications.created_at DESC LIMIT 50`, [teamId]);
		return c.json({ ok: true, payload: { available: Boolean(manifest), manifest: manifest ? {
			revision: manifest.revision, previousRevision: manifest.previousRevision, generatedAt: manifest.generatedAt,
			sourceClosure: manifest.sourceClosure, digest: manifest.digest, projects: manifest.projects,
			entryCount: manifest.entries.length,
		} : null, attempts } }, 200, { 'Cache-Control': 'private, no-store' });
	});

	app.post('/v1/teams/:teamId/knowledge/publications/rollback', async (c: any) => {
		const teamId = c.req.param('teamId');
		const access = await context.requireTeamAccess(c, store, teamId, 'knowledge:publish');
		if (access.response) return access.response;
		const body = await c.req.json().catch(() => ({}));
		const revision = String(body.revision ?? '').trim();
		const expectedRevision = String(body.expectedRevision ?? '').trim();
		if (!revision || !expectedRevision) return jsonError(c, 422, 'Choose a revision and confirm the current publication revision.');
		try {
			const manifest = await storage().rollback({ teamId, revision, expectedRevision });
			await store.recordAuditEvent({ eventType: 'knowledge.publication.rolled_back', actorType: 'user', actorId: access.principal.id,
				targetType: 'knowledge_publication', targetId: revision, data: { teamId, fromRevision: expectedRevision,
					toRevision: manifest.revision, sourceClosure: manifest.sourceClosure, manifestDigest: manifest.digest } });
			return c.json({ ok: true, code: 'knowledge_publication_rolled_back', message: 'Knowledge publication rolled back.',
				payload: { revision: manifest.revision, sourceClosure: manifest.sourceClosure } });
		} catch (error) {
			return jsonError(c, 409, error instanceof Error ? error.message : 'Knowledge publication rollback failed.',
				{ code: 'knowledge_publication_rollback_conflict' });
		}
	});
}
