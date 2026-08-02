function auditId(publicationId: string, suffix: string) {
	return `knowledge-publication:${publicationId}:${suffix}`;
}

async function semanticallyChanged(storage: any, earlier: any, current: any) {
	if (!earlier || earlier.content.sha256 === current.content.sha256) return Boolean(!earlier);
	const [priorBody, currentBody] = await Promise.all([
		storage.readObject(earlier.content.objectKey), storage.readObject(current.content.objectKey),
	]);
	if (!priorBody || !currentBody) throw new Error('Knowledge audit comparison requires both immutable publication objects.');
	const normalize = (body: string) => {
		const payload = JSON.parse(body);
		if (payload.source) payload.source.commitSha = null;
		return JSON.stringify(payload);
	};
	return normalize(priorBody) !== normalize(currentBody);
}

export async function recordPublicationEntryAudits(input: {
	store: any; storage: any; publication: any; workspace: any; previous: any; manifest: any;
}) {
	const previousEntries = new Map((input.previous?.entries ?? []).map((entry: any) => [`${entry.kind}:${entry.id}`, entry]));
	for (const entry of input.manifest.entries) {
		const earlier: any = previousEntries.get(`${entry.kind}:${entry.id}`);
		let eventType: string | null = null;
		if (entry.status === 'archived' && earlier?.status === 'published') eventType = `knowledge.${entry.kind}.archived`;
		else if (entry.status === 'published' && earlier?.status === 'archived') eventType = `knowledge.${entry.kind}.restored`;
		else if (entry.status === 'published' && !earlier) eventType = `knowledge.${entry.kind}.created`;
		else if (entry.status === 'published' && await semanticallyChanged(input.storage, earlier, entry)) eventType = `knowledge.${entry.kind}.updated`;
		if (eventType) await input.store.recordAuditEvent({
			id: auditId(input.publication.id, `${eventType}:${entry.id}`), eventType,
			actorType: 'user', actorId: input.workspace.actorUserId,
			targetType: entry.kind === 'book' ? 'book' : 'knowledge_page', targetId: entry.id,
			data: { teamId: input.workspace.teamId, projectId: entry.projectId, workspaceId: input.workspace.id,
				publicationId: input.publication.id, publishedRevision: input.manifest.revision },
		});
	}
}

export async function recordPublicationCompletedAudit(input: {
	store: any; publication: any; workspace: any; review: any; manifest: any; operationId: string; graphRevision?: string;
}) {
	await input.store.recordAuditEvent({
		id: auditId(input.publication.id, 'completed'), eventType: 'knowledge.publication.completed',
		actorType: 'service', actorId: input.operationId, targetType: 'knowledge_publication', targetId: input.publication.id,
		data: { projectId: input.workspace.projectId, workspaceId: input.workspace.id, reviewId: input.review.id,
			commitSha: input.publication.commit_sha, publishedRef: input.publication.published_ref,
			graphRevision: input.graphRevision, publishedRevision: input.manifest.revision,
			sourceClosure: input.manifest.sourceClosure, manifestDigest: input.manifest.digest },
	});
}
