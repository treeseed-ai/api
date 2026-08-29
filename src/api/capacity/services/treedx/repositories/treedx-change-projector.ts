import { createHash } from 'node:crypto';
import type { CapacityGovernanceDatabase } from '../../../database.ts';
import { CapacityGovernanceError } from '../../../database.ts';
import { enqueueTreeDxCommitReplication } from './treedx-commit-replication.ts';

function subjectKind(path: string) {
	const match = path.match(/(?:^|\/)(?:content\/)?(books|knowledge|notes|proposals|questions)\//u);
	return match?.[1] === 'books' ? 'book' : match?.[1] === 'proposals' ? 'proposal'
		: match?.[1] === 'questions' ? 'question' : match?.[1] === 'notes' ? 'note' : match?.[1] === 'knowledge' ? 'knowledge' : null;
}

function signalId(projectId: string, commitSha: string, path: string) {
	return `signal:treedx-change:${createHash('sha256').update(`${projectId}:${commitSha}:${path}`).digest('hex')}`;
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
	const records = [];
	for (const path of paths) {
		const kind = subjectKind(path);
		if (!kind) continue;
		const id = signalId(input.projectId, input.commitSha, path);
		const payload = { commitSha: input.commitSha, digest: createHash('sha256').update(`${input.commitSha}:${path}`).digest('hex'), changedPaths: [path], changeSummary: input.changeSummary, subjectKind: kind,
			...(kind === 'question' || kind === 'proposal' ? { inboxEligible: true, owningProjectId: input.projectId, authorAgentId: input.agentId ?? null } : {}) };
		await database.run(`INSERT INTO agent_signals
			(id,contract_id,subject_kind,subject_id,team_id,project_id,workday_run_id,assignment_id,agent_id,activity_type,capacity_provider_id,causation_id,correlation_id,origin,commit_sha,immutable_ref,digest,changed_paths_json,change_summary,evidence_ref,payload_json,metadata_json,created_at)
			VALUES (?,'content-changed',?,?,?,?,?,?,?,?,?,?,?,'treedx-change',?,?,?,?,?,?,?, ?, ?) ON CONFLICT(id) DO NOTHING`, [
			id, kind, path, project.team_id, input.projectId, input.workdayRunId ?? null, input.assignmentId ?? null,
			input.agentId ?? null, input.activityType ?? null, input.capacityProviderId ?? null,
			`commit:${input.commitSha}:${path}`, `commit:${input.commitSha}`, input.commitSha, input.immutableRef ?? input.commitSha,
			payload.digest, JSON.stringify([path]), input.changeSummary, `treedx-commit:${input.commitSha}`,
			JSON.stringify(payload), JSON.stringify({ actorType: input.actorType, actorId: input.actorId ?? null }), createdAt,
		]);
		const persisted = await database.first('SELECT * FROM agent_signals WHERE id = ?', [id]);
		if (persisted) records.push(persisted);
	}
	return records;
}
