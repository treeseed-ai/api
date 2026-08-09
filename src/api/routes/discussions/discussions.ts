import { commitDiscussionMessage, loadDiscussions, validateDiscussionContextRefs } from '../../discussions/content.ts';

function text(value: unknown, fallback = '') { return typeof value === 'string' && value.trim() ? value.trim() : fallback; }
function intent(value: unknown): 'discuss' | 'propose' | 'act' { return value === 'propose' || value === 'act' ? value : 'discuss'; }

export function installDiscussionRoutes(context: any) {
	const { app, jsonError, requireProjectAccess, requireTeamAccess, sessionEvents, store } = context;
	app.get('/v1/discussions', async (c: any) => {
		const projectId = text(c.req.query('projectId'));
		if (!projectId) return jsonError(c, 400, 'Discussion history requires a project.');
		const access = await requireProjectAccess(c, store, projectId, 'projects:read:team');
		if (access.response) return access.response;
		try {
			const payload = await loadDiscussions({ store, projectId, discussionId: text(c.req.query('discussionId')) || undefined, query: text(c.req.query('query')) || undefined });
			return c.json({ ok: true, payload });
		} catch (error) {
			return jsonError(c, 503, error instanceof Error ? error.message : 'TreeDX could not load Discussion history.', { code: 'discussion_content_unavailable' });
		}
	});
	app.post('/v1/discussions', async (c: any) => {
		const body = await c.req.json().catch(() => ({}));
		const teamId = text(body.teamId);
		if (!teamId) return jsonError(c, 400, 'Discussion requires a team.');
		const teamAccess = await requireTeamAccess(c, store, teamId, 'projects:read:team');
		if (teamAccess.response) return teamAccess.response;
		let projectId = text(body.projectId);
		if (!projectId) {
			const projects = await store.listTeamProjects(teamId);
			projectId = text(projects.find((project: any) => project.status === 'active' || !project.status)?.id, text(projects[0]?.id));
		}
		if (!projectId) return jsonError(c, 409, 'The team needs an active project with a TreeDX repository before starting a Discussion.');
		const projectAccess = await requireProjectAccess(c, store, projectId, 'projects:read:team');
		if (projectAccess.response) return projectAccess.response;
		if (projectAccess.details.project.teamId !== teamId) return jsonError(c, 403, 'Discussion project does not belong to the selected team.');
		const messageBody = text(body.body);
		if (!messageBody || messageBody.length > 20_000) return jsonError(c, 422, 'Discussion message must contain between 1 and 20,000 characters.');
		const selectedIntent = intent(body.intent);
		if (selectedIntent === 'act') {
			const decisionId = text(body.decisionId);
			if (!decisionId) return jsonError(c, 409, 'Act assignments require an approved decision and readiness evidence.', { code: 'discussion_act_decision_required' });
			const readiness = await store.getDecisionPlanningStatus(decisionId);
			if (!readiness || readiness.projectId !== projectId || readiness.humanApprovalState !== 'approved' || readiness.executionReadiness !== 'ready') return jsonError(c, 409, 'The selected decision is not approved and execution-ready for this project.', { code: 'discussion_act_not_ready', decisionId });
		}
		let authored; let contextRefs: Awaited<ReturnType<typeof validateDiscussionContextRefs>> = [];
		try {
			contextRefs = await validateDiscussionContextRefs({ store, projectId, teamId, values: body.contextRefs });
			authored = await commitDiscussionMessage({ store, projectId, teamId, principal: projectAccess.principal, body: messageBody, intent: selectedIntent, discussionId: text(body.discussionId) || undefined, topic: text(body.topic) || undefined, fileRefs: Array.isArray(body.fileRefs) ? body.fileRefs : [], contextRefs });
		} catch (error) {
			const details = error && typeof error === 'object' ? error as { status?: number; code?: string } : {};
			return jsonError(c, details.status ?? 503, error instanceof Error ? error.message : 'TreeDX could not preserve the Discussion message.', { code: details.code ?? 'discussion_content_unavailable' });
		}
		await sessionEvents.publish({ eventType: 'discussion.updated', teamId, projectId, resourceId: authored.discussion.id, payload: { discussionId: authored.discussion.id, messageId: authored.message.id, commitSha: authored.commitSha } })
			.catch((error: unknown) => console.warn('[api] Discussion session event degraded', { error: error instanceof Error ? error.message : String(error) }));
		if (!authored.mentions.length) return c.json({ ok: true, ...authored, assignments: [] }, 201);
		const membership = await store.first(`SELECT capacity_provider_id FROM capacity_provider_team_memberships WHERE team_id = ? AND status = 'approved' ORDER BY approved_at ASC LIMIT 1`, [teamId]);
		if (!membership?.capacity_provider_id) return c.json({ ok: true, ...authored, assignments: [], dispatch: { status: 'blocked', reason: 'No approved capacity provider membership is available.' } }, 202);
		try {
			const now = new Date(); const durationSeconds = Math.max(60, Math.min(3600, Number(body.durationSeconds ?? 900)));
			const run = await store.createCapacityWorkdayRun(teamId, {
				capacityProviderId: String(membership.capacity_provider_id), scenarioId: `discussion:${authored.discussion.id}`, environment: 'discussion', status: 'running', startedAt: now.toISOString(),
				parameters: { durationSeconds, deadlineAt: new Date(now.getTime() + durationSeconds * 1000).toISOString(), maxActiveAssignments: authored.mentions.length, planningOnly: selectedIntent !== 'act', projectSlugs: [projectAccess.details.project.slug], agentSelection: { agentSlugs: authored.mentions, activityTypes: ['chat'], classIds: [], classSlugs: [], mode: 'intersection' }, timePolicy: selectedIntent === 'act' ? { cooperativePlanningPercent: 10, governedExecutionPercent: 80, reservePercent: 10 } : { cooperativePlanningPercent: 90, governedExecutionPercent: 0, reservePercent: 10 }, planningSession: { rounds: 1, assignmentTimeboxSeconds: durationSeconds }, discussion: { discussionId: authored.discussion.id, messageId: authored.message.id, messagePath: authored.message.path, intent: selectedIntent, snapshotDigest: authored.snapshotDigest, commitSha: authored.commitSha, contextRefs, decisionId: text(body.decisionId) || null } },
			});
			return c.json({ ok: true, ...authored, workday: run, assignments: authored.mentions.map((agentSlug: string) => ({ id: `pending:${run.id}:${agentSlug}`, agentSlug, status: 'queued' })) }, 202);
		} catch (error) {
			return c.json({ ok: true, ...authored, assignments: [], dispatch: { status: 'blocked', reason: error instanceof Error ? error.message : 'Assignment scheduling failed.' } }, 202);
		}
	});
}
