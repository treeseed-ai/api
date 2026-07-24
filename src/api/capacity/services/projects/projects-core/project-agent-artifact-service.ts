type Row = Record<string, unknown>;

interface ModeRunPage {
	items: Row[];
	page: { hasMore: boolean; nextCursor?: string | null };
}

interface ArtifactStore {
	listAgentModeRunsPage(projectId: string, filters: { limit: number }): Promise<ModeRunPage>;
}

function record(value: unknown): Row {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
}

function records(value: unknown): Row[] {
	return Array.isArray(value) ? value.map(record).filter((item) => Object.keys(item).length > 0) : [];
}

function text(value: unknown, fallback = ''): string {
	return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function artifactRefs(run: Row): Row[] {
	const outputs = record(run.outputs);
	const metadata = record(outputs.metadata);
	const manifest = record(outputs.artifactManifest ?? metadata.artifactManifest);
	return records(manifest.contentReferences);
}

export async function collectProjectAgentArtifacts(
	store: ArtifactStore,
	projectId: string,
	modeRuns?: Row[],
): Promise<Row[]> {
	let runs = modeRuns;
	if (!runs) {
		const page = await store.listAgentModeRunsPage(projectId, { limit: 200 });
		if (page.page.hasMore) {
			throw Object.assign(new Error('Project artifact evidence exceeds the bounded mode-run projection.'), {
				code: 'project_agent_artifact_evidence_bound_exceeded',
				status: 409,
				details: { projectId, nextCursor: page.page.nextCursor ?? null },
			});
		}
		runs = page.items;
	}
	const artifacts: Row[] = [];
	for (const run of runs) {
		for (const ref of artifactRefs(run)) {
			const contentPath = text(ref.contentPath ?? ref.path);
			if (!contentPath) continue;
			artifacts.push({
				id: text(ref.id, contentPath),
				title: text(ref.title, contentPath.split('/').at(-1)?.replace(/\.(?:md|mdx)$/u, '') ?? contentPath),
				artifactKind: text(ref.artifactKind ?? ref.model, 'content_artifact'),
				model: text(ref.model),
				contentPath,
				subjectId: ref.subjectId ?? null,
				taskId: run.id,
				modeRunId: run.id,
				workDayId: record(run.capacityEnvelope).workDayId ?? record(run.metadata).workDayId ?? null,
				taskState: run.status,
				outputRef: `treedx:${contentPath}`,
				createdAt: run.completedAt ?? run.updatedAt ?? run.createdAt ?? null,
			});
		}
	}
	return [...new Map(artifacts.map((artifact) => [String(artifact.id ?? artifact.outputRef), artifact])).values()];
}
