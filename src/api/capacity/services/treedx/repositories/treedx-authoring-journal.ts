import { createHash } from 'node:crypto';

type Store = {
	getProject(projectId: string): Promise<{ teamId: string } | null>;
	upsertProjectTreeDxLibrary(projectId: string, input: Record<string, unknown>): Promise<{
		repositoryId?: string | null;
		contentRepositoryRef?: string | null;
	} | null>;
	run(sql: string, params?: unknown[]): Promise<unknown>;
	all(sql: string, params?: unknown[]): Promise<Array<Record<string, unknown>>>;
};

type ReadStore = { all(sql: string, params?: unknown[]): Promise<Array<Record<string, unknown>>> };

export type TreeDxAuthoringJournalInput = {
	projectId: string;
	repositoryId: string;
	commitSha: string;
	ref: string;
	changedPaths: string[];
	assignmentId?: string | null;
	actorType: string;
	actorId?: string | null;
	advanceProjectContentRef?: boolean;
	supersededBy?: string;
};

export type TreeDxWorkspaceJournalInput = {
	projectId: string;
	repositoryId: string;
	workspaceId: string;
	operationKey: string;
	ref: string;
	actorType: string;
	actorId?: string | null;
};

type TreeDxAuthoringState = 'unpublished' | 'integrated' | 'abandoned' | 'superseded';

function journalId(state: TreeDxAuthoringState, input: TreeDxAuthoringJournalInput) {
	return `treedx_authoring_${createHash('sha256').update([
		state,input.projectId,input.repositoryId,input.ref,input.commitSha,
	].join('\n')).digest('hex').slice(0, 32)}`;
}

export async function listUnpublishedTreeDxAuthoringState(store: ReadStore, projectId: string, assignmentId?: string) {
	const assignmentClause=assignmentId ? ' AND assignment_id = ?' : '';
	const rows = await store.all(`SELECT assignment_id, result_status, metadata_json, created_at FROM treedx_project_proxy_audit
		WHERE project_id = ?${assignmentClause} AND result_status IN ('authoring_unpublished','authoring_integrated','authoring_abandoned','authoring_superseded')
		ORDER BY created_at ASC, id ASC`, assignmentId ? [projectId,assignmentId] : [projectId]);
	rows.sort((left, right) => String(left.created_at ?? '').localeCompare(String(right.created_at ?? '')));
	const states = new Map<string, Record<string, unknown>>();
	for (const row of rows) {
		let metadata: Record<string, unknown> = {};
		try { metadata = JSON.parse(String(row.metadata_json ?? '{}')) as Record<string, unknown>; } catch { continue; }
		const commitSha = String(metadata.commitSha ?? '');
		if (!/^[a-f0-9]{40}$/u.test(commitSha)) continue;
		if (row.result_status === 'authoring_integrated' || row.result_status === 'authoring_abandoned'
			|| row.result_status === 'authoring_superseded') states.delete(commitSha);
		else states.set(commitSha, { ...metadata,...(row.assignment_id?{assignmentId:row.assignment_id}:{}),createdAt: row.created_at });
	}
	return [...states.values()];
}

export async function listReadableTreeDxAuthoringState(store: ReadStore, projectId: string) {
	const rows = await store.all(`SELECT assignment_id, result_status, metadata_json, created_at FROM treedx_project_proxy_audit
		WHERE project_id = ? AND result_status IN ('authoring_unpublished','authoring_integrated','authoring_abandoned','authoring_superseded')
		ORDER BY created_at ASC, id ASC`, [projectId]);
	rows.sort((left, right) => String(left.created_at ?? '').localeCompare(String(right.created_at ?? '')));
	const states = new Map<string, Record<string, unknown>>();
	for (const row of rows) {
		let metadata: Record<string, unknown> = {};
		try { metadata = JSON.parse(String(row.metadata_json ?? '{}')) as Record<string, unknown>; } catch { continue; }
		const commitSha = String(metadata.commitSha ?? '');
		if (!/^[a-f0-9]{40}$/u.test(commitSha)) continue;
		if (row.result_status === 'authoring_abandoned' || row.result_status === 'authoring_superseded') {
			states.delete(commitSha);
			continue;
		}
		states.set(commitSha, { ...metadata,...(row.assignment_id?{assignmentId:row.assignment_id}:{}),createdAt: row.created_at });
	}
	return [...states.values()];
}

export async function reconcileSupersededTreeDxAuthoringState(
	store: Store,
	input: Omit<TreeDxAuthoringJournalInput,'commitSha'|'changedPaths'|'assignmentId'> & {
		observedHead: string;
	},
) {
	if (!/^[a-f0-9]{40}$/u.test(input.observedHead)) throw new Error('TreeDX authoring reconciliation requires an exact observed head.');
	const unpublished=await listUnpublishedTreeDxAuthoringState(store,input.projectId);
	const candidates=unpublished.filter((entry)=>!entry.assignmentId
		&& entry.repositoryId===input.repositoryId && entry.ref===input.ref
		&& entry.commitSha!==input.observedHead);
	for (const entry of candidates) {
		await recordTreeDxAuthoringState(store,'superseded',{
			projectId:input.projectId,repositoryId:input.repositoryId,commitSha:String(entry.commitSha),ref:input.ref,
			changedPaths:Array.isArray(entry.changedPaths)?entry.changedPaths.map(String):[],actorType:input.actorType,
			actorId:input.actorId,advanceProjectContentRef:false,supersededBy:input.observedHead,
		});
	}
	return { observedHead:input.observedHead,supersededCommits:candidates.map((entry)=>String(entry.commitSha)).sort() };
}

export async function recordTreeDxAuthoringState(
	store: Store,
	state: TreeDxAuthoringState,
	input: TreeDxAuthoringJournalInput,
) {
	if (!/^[a-f0-9]{40}$/u.test(input.commitSha)) throw new Error('TreeDX authoring journal requires an exact commit SHA.');
	const project = await store.getProject(input.projectId);
	if (!project) throw new Error(`TreeDX authoring journal project ${input.projectId} does not exist.`);
	if (state === 'integrated' && input.advanceProjectContentRef !== false) {
		const binding = await store.upsertProjectTreeDxLibrary(input.projectId, {
			repositoryId: input.repositoryId,
			contentRepositoryRef: input.commitSha,
		});
		if (!binding || binding.repositoryId !== input.repositoryId
			|| binding.contentRepositoryRef !== input.commitSha) {
			throw new Error('Integrated TreeDX authoring did not advance the authoritative project content ref.');
		}
	}
	const id = journalId(state,input);
	const createdAt = new Date().toISOString();
	await store.run(`INSERT INTO treedx_project_proxy_audit (
		id, team_id, project_id, assignment_id, actor_type, actor_id, method, path, handle_json, result_status,
		reason_code, reason, metadata_json, created_at
	) VALUES (?, ?, ?, ?, ?, ?, 'POST', ?, '{}', ?, NULL, NULL, ?, ?)
	ON CONFLICT (id) DO NOTHING`, [
		id,project.teamId,input.projectId,input.assignmentId ?? null,input.actorType,input.actorId ?? null,
		input.ref,`authoring_${state}`,JSON.stringify({
			repositoryId:input.repositoryId,commitSha:input.commitSha,ref:input.ref,
			changedPaths:[...new Set(input.changedPaths)].sort(),
			advanceProjectContentRef:input.advanceProjectContentRef !== false,
			...(state==='superseded'?{supersededBy:input.supersededBy}:{}),
		}),createdAt,
	]);
	return { id,state,createdAt };
}

export async function recordTreeDxWorkspaceState(
	store: Store,
	state: 'open' | 'closed',
	input: TreeDxWorkspaceJournalInput,
) {
	const project = await store.getProject(input.projectId);
	if (!project) throw new Error(`TreeDX workspace journal project ${input.projectId} does not exist.`);
	const id = `treedx_workspace_${state}_${createHash('sha256').update([
		input.projectId,input.repositoryId,input.workspaceId,
	].join('\n')).digest('hex').slice(0, 32)}`;
	const createdAt = new Date().toISOString();
	await store.run(`INSERT INTO treedx_project_proxy_audit (
		id, team_id, project_id, assignment_id, actor_type, actor_id, method, path, handle_json, result_status,
		reason_code, reason, metadata_json, created_at
	) VALUES (?, ?, ?, NULL, ?, ?, 'POST', ?, '{}', ?, NULL, NULL, ?, ?)
	ON CONFLICT (id) DO NOTHING`, [
		id,project.teamId,input.projectId,input.actorType,input.actorId ?? null,input.ref,
		`authoring_workspace_${state}`,JSON.stringify({
			repositoryId:input.repositoryId,workspaceId:input.workspaceId,
			operationKey:input.operationKey,ref:input.ref,
		}),createdAt,
	]);
	return { id,state,createdAt };
}

export async function listOpenTreeDxWorkspaces(
	store: Pick<Store,'all'>,
	input: { projectId: string; repositoryId: string; operationKey: string },
) {
	const rows = await store.all(`SELECT result_status, metadata_json, created_at FROM treedx_project_proxy_audit
		WHERE project_id = ? AND result_status IN ('authoring_workspace_open','authoring_workspace_closed')
		ORDER BY created_at ASC, id ASC LIMIT 500`, [input.projectId]);
	const attempts = new Map<string,{ workspaceId:string; createdAt:string }>();
	for (const row of rows) {
		let metadata: Record<string, unknown> = {};
		try { metadata = JSON.parse(String(row.metadata_json ?? '{}')) as Record<string, unknown>; } catch { continue; }
		if (String(metadata.repositoryId ?? '') !== input.repositoryId
			|| String(metadata.operationKey ?? '') !== input.operationKey) continue;
		const workspaceId=String(metadata.workspaceId ?? '');
		if (!workspaceId) continue;
		if (row.result_status === 'authoring_workspace_closed') attempts.delete(workspaceId);
		else attempts.set(workspaceId,{workspaceId,createdAt:String(row.created_at ?? '')});
	}
	return [...attempts.values()];
}
