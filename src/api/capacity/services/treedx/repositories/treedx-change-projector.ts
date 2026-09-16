import type { CapacityGovernanceDatabase } from '../../../database.ts';
import { CapacityGovernanceError } from '../../../database.ts';
import { enqueueTreeDxCommitReplication } from './treedx-commit-replication.ts';
import { reconcileExecutionGraph } from '../../../../control-plane/repositories/capacity/execution/execution-graph-service.ts';

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
	// An assignment workspace commit is unpublished output. Its canonical
	// AssignmentResult transition advances the graph; projecting the raw commit as
	// fresh intent creates a second authority and can re-admit the completed node.
	if (!input.assignmentId
		&& paths.some((path) => ['execution_plan', 'proposal', 'question', 'note'].includes(subjectKind(path) ?? ''))) {
		await reconcileExecutionGraph(database, String(project.team_id), { projectId: input.projectId }, `treedx:${input.projectId}:${input.commitSha}`);
	}
	return [];
}
