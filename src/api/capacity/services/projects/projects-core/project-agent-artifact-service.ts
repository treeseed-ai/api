type Row = Record<string, unknown>;

interface ArtifactStore {
	getProjectDetails(projectId: string): Promise<Row | null>;
	listProviderAssignmentsPage(teamId: string, filters: { projectId: string; limit: number }): Promise<{
		items: Row[]; page: { hasMore: boolean; nextCursor?: string | null };
	}>;
}

const record = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const rows = (value: unknown): Row[] => Array.isArray(value) ? value.map(record) : [];
const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';

/** Project artifact summaries are projections of immutable assignment results, not another execution record. */
export async function collectProjectAgentArtifacts(store: ArtifactStore, projectId: string, assignments?: Row[]): Promise<Row[]> {
	let evidence = assignments;
	if (!evidence) {
		const project = await store.getProjectDetails(projectId);
		if (!project) return [];
		const page = await store.listProviderAssignmentsPage(text(project.teamId), { projectId, limit: 200 });
		if (page.page.hasMore) throw Object.assign(new Error('Project artifact evidence exceeds the bounded assignment projection.'), {
			code: 'project_agent_artifact_evidence_bound_exceeded', status: 409,
			details: { projectId, nextCursor: page.page.nextCursor ?? null },
		});
		evidence = page.items;
	}
	const artifacts: Row[] = [];
	for (const assignment of evidence) {
		const result = record(assignment.assignmentResult);
		const grant = record(record(assignment.assignmentAttempt).grant);
		const writable = rows(grant.contentWrite);
		for (const reference of rows(result.references)) {
			if (reference.kind !== 'treedx') continue;
			const repository = text(reference.repository);
			const contentPath = text(reference.path);
			const authorization = writable.find((entry) => text(entry.repository) === repository && text(entry.path) === contentPath);
			if (!authorization || !text(reference.commit)) continue;
			const model = text(authorization.model);
			artifacts.push({
				id: `${text(assignment.id)}:${contentPath}`,
				title: contentPath.split('/').at(-1)?.replace(/\.(?:md|mdx)$/u, '') ?? contentPath,
				artifactKind: model || 'content_artifact', model, contentPath,
				taskId: text(assignment.taskId) || text(assignment.id), assignmentId: text(assignment.id),
				workDayId: assignment.workDayId ?? null, taskState: assignment.status,
				outputRef: `treedx:${repository}:${text(reference.commit)}:${contentPath}`,
				createdAt: result.completedAt ?? assignment.completedAt ?? assignment.updatedAt ?? null,
			});
		}
	}
	return artifacts;
}
