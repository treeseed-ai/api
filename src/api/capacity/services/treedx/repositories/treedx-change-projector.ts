import type { CapacityGovernanceDatabase } from '../../../database.ts';
import { CapacityGovernanceError } from '../../../database.ts';
import { enqueueTreeDxCommitReplication } from './treedx-commit-replication.ts';
import { reconcileExecutionGraph } from '../../../../control-plane/repositories/capacity/execution/execution-graph-service.ts';
import { resolveKnowledgeGatewayConnection } from '../../../../knowledge/gateway-treedx-connection.ts';
import { snapshotAgentDefinitions } from '../../capacity/agents/agent-definition-snapshot.ts';

type Row = Record<string, unknown>;
const record = (value: unknown): Row => {
	if (value && typeof value === 'object' && !Array.isArray(value)) return value as Row;
	if (typeof value === 'string') try { return record(JSON.parse(value)); } catch { return {}; }
	return {};
};

async function projectAgentDefinitions(database: CapacityGovernanceDatabase, input: {
	projectId: string; commitSha: string; immutableRef?: string | null;
}) {
	const connection = await resolveKnowledgeGatewayConnection(database, {
		projectId: input.projectId, write: false, authoringPaths: true, readRefs: [input.commitSha],
	});
	if (!connection) throw new CapacityGovernanceError('agent_profile_library_unavailable',
		'Published agent definitions require an authoritative TreeDX library binding.', 409, { projectId: input.projectId });
	const snapshot = await snapshotAgentDefinitions(connection, input.commitSha);
	const classes = (await database.all('SELECT * FROM project_agent_classes WHERE project_id=? ORDER BY created_at,id', [input.projectId])).map(record);
	const project = await database.first('SELECT team_id FROM projects WHERE id=? LIMIT 1', [input.projectId]);
	if (!project?.team_id) throw new CapacityGovernanceError('agent_profile_project_missing',
		'Published agent definitions require an active project.', 409, { projectId: input.projectId });
	for (const file of snapshot.files) {
		const slug = file.definition.agentClass;
		const existing = classes.find((entry) => String(entry.slug ?? '') === slug && entry.status === 'active')
			?? classes.find((entry) => String(entry.slug ?? '') === slug);
		const metadata = { ...record(existing?.metadata_json ?? existing?.metadata), source: 'project-library', immutableRef: input.commitSha,
				libraryRef: input.immutableRef ?? connection.baseRef, definitionPaths: [file.path],
				definitionDigest: file.sourceDigest.replace(/^sha256:/u, '') };
		const now = new Date().toISOString();
		if (existing) await database.run(`UPDATE project_agent_classes SET name=?,status='active',handler_refs_json=?,metadata_json=?,updated_at=?
			WHERE id=? AND project_id=?`, [file.definition.name, JSON.stringify({ agents: [file.definition] }), JSON.stringify(metadata), now,
			String(existing.id), input.projectId]);
		else await database.run(`INSERT INTO project_agent_classes
			(id,team_id,project_id,slug,name,status,handler_refs_json,metadata_json,created_at,updated_at)
			VALUES (?,?,?,?,?,'active',?,?,?,?)`, [`${input.projectId}:${slug}`, String(project.team_id), input.projectId, slug,
			file.definition.name, JSON.stringify({ agents: [file.definition] }), JSON.stringify(metadata), now, now]);
	}
}

function subjectKind(path: string) {
	const match = path.match(/(?:^|\/)(?:content\/)?(books|knowledge|notes|proposals|questions|execution-plans)\//u);
	return match?.[1] === 'books' ? 'book' : match?.[1] === 'proposals' ? 'proposal'
		: match?.[1] === 'questions' ? 'question' : match?.[1] === 'execution-plans' ? 'execution_plan'
			: match?.[1] === 'notes' ? 'note' : match?.[1] === 'knowledge' ? 'knowledge' : null;
}

export async function projectTreeDxCommitSignals(database: CapacityGovernanceDatabase, input: {
	projectId: string;
	commitSha: string;
	immutableRef?: string | null;
	changedPaths: string[];
	changeSummary: string;
	assignmentId?: string | null;
	workdayRunId?: string | null;
	agentId?: string | null;
	activityType?: string | null;
	capacityProviderId?: string | null;
	actorType: 'user' | 'capacity_provider' | 'service';
	actorId?: string | null;
	createdAt?: string;
}) {
	if (!/^[a-f0-9]{40}$/u.test(input.commitSha)) throw new CapacityGovernanceError('treedx_change_commit_invalid', 'TreeDX change projection requires an immutable commit SHA.', 500);
	const project = await database.first('SELECT team_id FROM projects WHERE id = ? LIMIT 1', [input.projectId]);
	if (!project?.team_id) throw new CapacityGovernanceError('treedx_change_project_missing', 'TreeDX change projection requires an active project.', 500, { projectId: input.projectId });
	const createdAt = input.createdAt ?? new Date().toISOString();
	await enqueueTreeDxCommitReplication(database, {
		teamId: String(project.team_id), projectId: input.projectId, commitSha: input.commitSha, createdAt,
		...(input.immutableRef?.startsWith('refs/') ? { sourceRef: input.immutableRef } : {}),
	});
	const paths = [...new Set(input.changedPaths.map((path) => path.trim().replace(/^\/+|\/+$/gu, '')).filter(Boolean))].sort();
	if (paths.some((path) => /(?:^|\/)agents\/[^/]+\.mdx?$/u.test(path))) {
		await projectAgentDefinitions(database, input);
	}
	// An assignment workspace commit is unpublished output. Its canonical
	// AssignmentResult transition advances the graph; projecting the raw commit as
	// fresh intent creates a second authority and can re-admit the completed node.
	if (!input.assignmentId
		&& paths.some((path) => ['execution_plan', 'proposal', 'question', 'note'].includes(subjectKind(path) ?? ''))) {
		await reconcileExecutionGraph(database, String(project.team_id), { projectId: input.projectId }, `treedx:${input.projectId}:${input.commitSha}`);
	}
	return [];
}
