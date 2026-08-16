import { createHash } from 'node:crypto';
import { changeDiscussionStatus,commitDiscussionMessage, loadDiscussions, validateDiscussionContextRefs } from '../../discussions/content.ts';
import { admitDiscussionInvocations,resolveDiscussionInvocationAgents } from '../../capacity/services/capacity/invocations/discussion-invocation-service.ts';

function text(value: unknown, fallback = '') { return typeof value === 'string' && value.trim() ? value.trim() : fallback; }
function intent(value: unknown): 'discuss' | 'propose' { return value === 'propose' ? value : 'discuss'; }
function stableId(scope:string,key:string) { return createHash('sha256').update(`${scope}:${key}`).digest('hex').slice(0,32); }
function record(value: unknown): Record<string, unknown> {
	if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
	if (typeof value === 'string') try { return record(JSON.parse(value)); } catch { return {}; }
	return {};
}

export async function cancelArchivedDiscussionCapacity(
	store: any,
	projectId: string,
	discussionId: string,
	now = new Date().toISOString(),
	cancelPending?: (teamId:string,assignmentId:string,idempotencyKey:string) => Promise<unknown>,
) {
	const candidates = await store.all(
		`SELECT id,status,metadata_json FROM agent_invocation_requests
		 WHERE project_id = ? AND execution_kind = 'conversation' AND status IN ('queued','blocked','admitted','running')`,
		[projectId],
	);
	const invocations = candidates.filter((candidate: Record<string, unknown>) => text(record(candidate.metadata_json).discussionId) === discussionId);
	const invocationIds = invocations.map((candidate: Record<string, unknown>) => text(candidate.id)).filter(Boolean);
	const assignments = invocationIds.length ? await store.all(
		`SELECT id,team_id,invocation_id,status,lease_state,metadata_json FROM capacity_provider_assignments
		 WHERE project_id = ? AND invocation_id IN (${invocationIds.map(() => '?').join(',')}) AND status IN ('pending','leased')`,
		[projectId, ...invocationIds],
	) : [];
	const operations = [
		...invocations.filter((candidate: Record<string, unknown>) => ['queued', 'blocked'].includes(text(candidate.status))).map((candidate: Record<string, unknown>) => ({
			query: `UPDATE agent_invocation_requests SET status='cancelled',completed_at=?,blocking_state_json=?,updated_at=? WHERE id=? AND project_id=? AND status IN ('queued','blocked')`,
			params: [now, JSON.stringify({ code: 'discussion_archived', discussionId }), now, candidate.id, projectId],
		})),
		...assignments.filter((assignment: Record<string, unknown>) => text(assignment.status)==='leased').map((assignment: Record<string, unknown>) => ({
			query: `UPDATE capacity_provider_assignments SET metadata_json=?,updated_at=? WHERE id=? AND project_id=? AND status IN ('pending','leased')`,
			params: [JSON.stringify({ ...record(assignment.metadata_json), cancellationRequested: true, cancellationReason: 'discussion_archived', discussionId }), now, assignment.id, projectId],
		})),
	];
	if (operations.length) await store.batch(operations);
	for(const assignment of assignments.filter((candidate:Record<string,unknown>)=>text(candidate.status)==='pending')) {
		if(!cancelPending) continue;
		const operationKey=`discussion-archive:${projectId}:${discussionId}:${text(assignment.id)}`;
		await cancelPending(text(assignment.team_id),text(assignment.id),operationKey);
		await store.run(`UPDATE agent_invocation_requests SET status='cancelled',completed_at=COALESCE(completed_at,?),blocking_state_json=?,updated_at=? WHERE id=? AND project_id=? AND status IN ('admitted','running')`,[
			now,JSON.stringify({code:'discussion_archived',discussionId,assignmentId:assignment.id}),now,assignment.invocation_id,projectId,
		]);
	}
	return { invocationIds, assignmentIds: assignments.map((assignment: Record<string, unknown>) => text(assignment.id)).filter(Boolean) };
}
export function discussionRouteFailure(error: unknown, fallbackStatus: number, fallbackCode: string) {
	const value = error && typeof error === 'object' ? error as { status?: number; code?: string; details?: unknown } : {};
	return {
		status: Number.isInteger(value.status) ? Number(value.status) : fallbackStatus,
		message: error instanceof Error ? error.message : 'TreeDX Discussion operation failed.',
		code: value.code ?? fallbackCode,
		details: value.details,
	};
}
export function discussionInvocationParent(body: Record<string, unknown>) {
	return {
		parentWorkdayId: text(body.parentWorkdayId) || null,
		parentAssignmentId: text(body.parentAssignmentId) || null,
	};
}

export function discussionContinuationReplyEvidence(
	assignment: Record<string, unknown> | null,
	discussionId: string,
	messages: Array<Record<string, unknown>>,
) {
	if (!assignment) return null;
	const metadata = record(assignment.metadata_json);
	if (text(metadata.operationalState) !== 'suspended') return null;
	const waitingDiscussionId = text(metadata.waitingDiscussionId);
	const waitingMessageId = text(metadata.waitingMessageId);
	if (waitingDiscussionId !== discussionId || !waitingMessageId) {
		throw Object.assign(new Error('The parent assignment is not suspended on this exact Discussion message.'), {
			status: 409, code: 'discussion_continuation_source_mismatch',
			details: { discussionId, waitingDiscussionId, waitingMessageId },
		});
	}
	const source = messages.find((message) => text(message.id) === waitingMessageId);
	const sourcePath = text(source?.path);
	if (!sourcePath) {
		throw Object.assign(new Error('The required-response source message is missing from authoritative TreeDX history.'), {
			status: 409, code: 'discussion_continuation_source_missing', details: { discussionId, waitingMessageId },
		});
	}
	return { replyTo: waitingMessageId, sourceMessageRefs: [waitingMessageId, sourcePath] };
}

export function installDiscussionRoutes(context: any) {
	const { app, capacity, jsonError, requireProjectAccess, requireTeamAccess, sessionEvents, store } = context;
	const invocationStore = capacity ?? store;
	app.get('/v1/discussions', async (c: any) => {
		const projectId = text(c.req.query('projectId'));
		if (!projectId) return jsonError(c, 400, 'Discussion history requires a project.');
		const access = await requireProjectAccess(c, store, projectId, 'projects:read:team');
		if (access.response) return access.response;
		try {
			const collectionValue = text(c.req.query('collection'));
			const collection = ['discussions','messages','events'].includes(collectionValue)
				? collectionValue as 'discussions'|'messages'|'events' : undefined;
			const payload = await loadDiscussions({
				store, projectId, discussionId: text(c.req.query('discussionId')) || undefined,
				query: text(c.req.query('query')) || undefined, collection,
				limit: Number(c.req.query('limit')) || undefined, after: text(c.req.query('after')) || undefined,
			});
			return c.json({ ok: true, payload });
		} catch (error) {
			const failure = discussionRouteFailure(error, 503, 'discussion_content_unavailable');
			return jsonError(c, failure.status, failure.message, { code: failure.code, details: failure.details });
		}
	});
	app.post('/v1/discussions', async (c: any) => {
		const body = await c.req.json().catch(() => ({}));
		const idempotencyKey=text(body.idempotencyKey,text(c.req.header('Idempotency-Key')));
		if(!idempotencyKey)return jsonError(c,400,'Discussion mutation requires an idempotency key.',{ code:'idempotency_key_required' });
		const simulatedHuman=body.simulateHuman===true; const requestedWorkdayId=text(body.workdayId); const evidenceReason=text(body.reason);
		const { parentWorkdayId,parentAssignmentId }=discussionInvocationParent(body);
		if(simulatedHuman&&(!requestedWorkdayId||!evidenceReason))return jsonError(c,422,'Simulated-human discussion requires an exact workday and evidence reason.',{ code:'simulated_human_evidence_required' });
		const teamId = text(body.teamId);
		if (!teamId) return jsonError(c, 400, 'Discussion requires a team.');
		const teamAccess = await requireTeamAccess(c, store, teamId, simulatedHuman?'teams:manage:team':'projects:read:team');
		if (teamAccess.response) return teamAccess.response;
		let projectId = text(body.projectId);
		if (!projectId) {
			const projects = await store.listTeamProjects(teamId);
			projectId = text(projects.find((project: any) => project.status === 'active' || !project.status)?.id, text(projects[0]?.id));
		}
		if (!projectId) return jsonError(c, 409, 'The team needs an active project with a TreeDX repository before starting a Discussion.');
		const projectAccess = simulatedHuman?null:await requireProjectAccess(c, store, projectId, 'projects:read:team');
		if (projectAccess?.response) return projectAccess.response;
		const project=simulatedHuman?await store.getProject(projectId):projectAccess?.details.project;
		if (!project||project.teamId !== teamId) return jsonError(c, 403, 'Discussion project does not belong to the selected team.');
		const principal=simulatedHuman?teamAccess.principal:projectAccess?.principal;
		const messageBody = text(body.body);
		if (!messageBody || messageBody.length > 20_000) return jsonError(c, 422, 'Discussion message must contain between 1 and 20,000 characters.');
		if (body.intent === 'act') return jsonError(c, 409, 'Discussion cannot directly create acting authority. Prepare an approval-backed operation handoff instead.', { code: 'discussion_operation_handoff_required' });
		const selectedIntent = intent(body.intent);
		const discussionId=text(body.discussionId,`discussion-${stableId(projectId,idempotencyKey)}`);
		const messageId=stableId(discussionId,idempotencyKey);
		let authored; let contextRefs: Awaited<ReturnType<typeof validateDiscussionContextRefs>> = [];
		try {
			const parentAssignment = parentAssignmentId ? await store.first(
				`SELECT id,metadata_json FROM capacity_provider_assignments WHERE id = ? AND team_id = ? AND project_id = ? LIMIT 1`,
				[parentAssignmentId,teamId,projectId],
			) : null;
			if (parentAssignmentId && !parentAssignment) {
				throw Object.assign(new Error('The explicit parent assignment does not exist in this team and project.'), {
					status:409,code:'discussion_parent_assignment_not_found',details:{parentAssignmentId,teamId,projectId},
				});
			}
			const waitingMessageId = text(record(parentAssignment?.metadata_json).waitingMessageId);
			const continuationHistory = parentAssignment ? await loadDiscussions({
				store,projectId,discussionId,query:waitingMessageId||undefined,collection:'messages',limit:10,
			}) : { messages:[] };
			const continuationEvidence = discussionContinuationReplyEvidence(parentAssignment,discussionId,continuationHistory.messages);
			const history=await loadDiscussions({ store,projectId,discussionId,query:messageId,collection:'messages' }).catch(()=>({ messages:[] }));
			const replay=history.messages.find((entry:any)=>text(entry.id)===messageId);
			if(replay) {
				if(text(replay.body)!==messageBody)return jsonError(c,409,'The idempotency key is already bound to another discussion message.',{ code:'discussion_idempotency_conflict' });
				let invocations = await store.all(`SELECT id,status,execution_id,assignment_id,metadata_json FROM agent_invocation_requests WHERE team_id = ? AND idempotency_key LIKE ? ORDER BY id`, [teamId, `${idempotencyKey}:%`]);
				const replayMentions = Array.isArray(replay.frontmatter?.mentionedAgents)
					? replay.frontmatter.mentionedAgents.map((value: unknown) => text(value)).filter(Boolean)
					: [];
				const replayAgents=await resolveDiscussionInvocationAgents(invocationStore,{teamId,projectId,discussionId,parentAssignmentId,mentionedAgents:replayMentions});
				if (replayAgents.length) {
					contextRefs = await validateDiscussionContextRefs({ store, projectId, teamId, values: body.contextRefs });
					invocations = await admitDiscussionInvocations(invocationStore, {
						teamId, projectId, projectSlug: text(project.slug, project.id), discussionId,
						messageId, messagePath: text(replay.path), messageCommit: text(record(invocations[0]?.metadata_json).sourceCommit, text(history.ref)), contextRefs,
						agentSlugs: replayAgents, idempotencyKey, parentWorkdayId,
						parentAssignmentId,
						durationSeconds: Math.max(60, Math.min(3600, Number(body.durationSeconds ?? 900))),
						requestedById: text(principal?.id) || null,
					});
				}
				return c.json({ ok:true,discussion:{ id:discussionId },message:replay,invocations,replayed:true });
			}
			contextRefs = await validateDiscussionContextRefs({ store, projectId, teamId, values: body.contextRefs });
			const existingDiscussion = text(body.discussionId)
				? await loadDiscussions({ store,projectId,discussionId,collection:'discussions',limit:1 }).catch(()=>({ discussions:[] }))
				: { discussions:[] };
			const existingTopic = text(record(existingDiscussion.discussions[0]?.frontmatter).topic);
			authored = await commitDiscussionMessage({ store, projectId, teamId, principal, body: messageBody, intent: selectedIntent,
				discussionId,messageId,createDiscussion:!text(body.discussionId),topic: existingTopic || text(body.topic) || undefined,
				fileRefs: Array.isArray(body.fileRefs) ? body.fileRefs : [], contextRefs,
				...(continuationEvidence ?? {}),
			});
		} catch (error) {
			const failure = discussionRouteFailure(error, 503, 'discussion_content_unavailable');
			return jsonError(c, failure.status, failure.message, { code: failure.code, details: failure.details });
		}
		const observed = await loadDiscussions({ store, projectId, discussionId: authored.discussion.id, query: authored.message.id, collection:'messages' });
		const observedMessage = observed.messages.find((entry: any) => text(entry.path) === authored.message.path);
		if (!observedMessage || text(observedMessage.body) !== messageBody) return jsonError(c, 503, 'TreeDX did not authoritatively return the committed Discussion message.', { code: 'discussion_readback_failed', messageId: authored.message.id });
		await sessionEvents.publish({ eventType: 'discussion.updated', teamId, projectId, resourceId: authored.discussion.id, payload: { discussionId: authored.discussion.id, messageId: authored.message.id, commitSha: authored.commitSha } })
			.catch((error: unknown) => console.warn('[api] Discussion session event degraded', { error: error instanceof Error ? error.message : String(error) }));
		try {
			const invocationAgents=await resolveDiscussionInvocationAgents(invocationStore,{teamId,projectId,discussionId:authored.discussion.id,parentAssignmentId,mentionedAgents:authored.mentions});
			if(!invocationAgents.length)return c.json({ ok: true, ...authored, invocations: [],replayed:false }, 201);
			const invocations = await admitDiscussionInvocations(invocationStore, {
				teamId, projectId, projectSlug: text(project.slug, project.id), discussionId: authored.discussion.id,
				messageId: authored.message.id, messagePath: authored.message.path, messageCommit: authored.commitSha,
				contextRefs, agentSlugs: invocationAgents, idempotencyKey, parentWorkdayId,
				parentAssignmentId, durationSeconds: Math.max(60, Math.min(3600, Number(body.durationSeconds ?? 900))),
				requestedById: text(principal?.id) || null,
			});
			return c.json({ ok: true, ...authored, invocations,replayed:false }, 202);
		} catch (error) {
			const failure = discussionRouteFailure(error, 409, 'discussion_invocation_failed');
			return jsonError(c, failure.status, failure.message, { code: failure.code, details: failure.details, discussionId: authored.discussion.id, messageId: authored.message.id });
		}
	});
	app.post('/v1/discussions/:discussionId/status',async(c:any)=>{
		const body=await c.req.json().catch(()=>({})); const projectId=text(body.projectId); const status=body.status==='active'?'active':body.status==='archived'?'archived':null;
		if(!projectId||!status)return jsonError(c,422,'Discussion lifecycle requires a project and active or archived status.',{code:'discussion_status_invalid'});
		const access=await requireProjectAccess(c,store,projectId,'projects:read:team'); if(access.response)return access.response;
		try{
			const result=await changeDiscussionStatus({store,projectId,teamId:access.details.project.teamId,discussionId:c.req.param('discussionId'),status,principal:access.principal});
			if(status==='archived')await cancelArchivedDiscussionCapacity(store,projectId,c.req.param('discussionId'),new Date().toISOString(),
				(teamId,assignmentId,idempotencyKey)=>invocationStore.cancelCapacityAssignment(teamId,assignmentId,{idempotencyKey,reason:'The source Discussion was archived.'}));
			await sessionEvents.publish({eventType:'discussion.lifecycle',teamId:access.details.project.teamId,projectId,resourceId:c.req.param('discussionId'),payload:{status,commitSha:result.commitSha}});
			return c.json({ok:true,payload:result});
		}catch(error){const failure=discussionRouteFailure(error,409,'discussion_status_failed');return jsonError(c,failure.status,failure.message,{code:failure.code,details:failure.details});}
	});
}
