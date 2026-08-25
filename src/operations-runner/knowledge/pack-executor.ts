import { buildKnowledgeSnapshotPack } from '../../api/knowledge/packs/knowledge-pack-builder.ts';
import { loadPublishedKnowledgeSnapshots } from '../../api/knowledge/published-catalog.ts';
import { createKnowledgePublicationStorage } from '../../api/knowledge/publication-storage.ts';
import { createPrivateObjectStorage } from '../../api/storage/private-object-storage.ts';

export function createKnowledgePackExecutor(options: any) {
	const environment = options.environment ?? options.config?.environment
		?? process.env.TREESEED_PLATFORM_RUNNER_ENVIRONMENT;
	return {
		namespace: 'knowledge', operation: 'build_pack',
		async run(input: any, context: any) {
			const store = options.controlPlaneStore;
			if (!store) throw new Error('Knowledge-pack creation requires a control-plane store.');
			const build = await store.getKnowledgePackBuild(String(input?.buildId ?? ''));
			if (!build || build.status !== 'queued') throw new Error('Queued knowledge-pack build was not found.');
			const started = await store.updateKnowledgePackBuild(build.id, { expectedStatus: 'queued', status: 'building' });
			if (!started.ok) throw new Error('Knowledge-pack build state changed before execution.');
			await context.checkpoint({ phase: 'knowledge.pack.snapshot', buildId: build.id },
				{ kind: 'knowledge.pack.snapshot', data: { buildId: build.id, teamId: build.teamId } });
			try {
				const access = await store.getTeamAccessSummary(build.teamId, { id: build.requestedByUserId, roles: ['user'], permissions: [] });
				if (!access.permissions.includes('knowledge:build-packs')) {
					throw new Error('The requesting user no longer has permission to build knowledge packs for this team.');
				}
				const publicationStorage = createKnowledgePublicationStorage({ adapter: options.knowledgePublicationStorage,
					environment });
				const manifest = await publicationStorage.readRevision(build.teamId, build.publicationRevision);
				if (!manifest) throw new Error('The source knowledge publication is no longer available.');
				const projects = await loadPublishedKnowledgeSnapshots(publicationStorage, manifest);
				const pack = buildKnowledgeSnapshotPack({ id: build.id, teamId: build.teamId,
					createdAt: build.createdAt, projects, bookIds: build.bookIds,
					publicationRevision: manifest.revision, publicationSourceClosure: manifest.sourceClosure });
				const storage = createPrivateObjectStorage({ adapter: options.privateObjectStorage });
				const saved = await storage.put('knowledge-packs', pack.bytes, 'application/zip');
				const artifact = { storageKey: saved.key, digest: saved.digest, byteSize: pack.bytes.length,
					fileName: pack.fileName, manifest: pack.manifest,
					expiresAt: new Date(Date.parse(build.createdAt) + 30 * 24 * 60 * 60_000).toISOString() };
				const completed = await store.updateKnowledgePackBuild(build.id, { expectedStatus: 'building', status: 'completed',
					sourceClosure: pack.manifest.sourceClosure, artifact });
				if (!completed.ok) { await storage.delete(saved.key); throw new Error('Knowledge-pack build state changed before completion.'); }
				await store.recordAuditEvent({ eventType: 'knowledge.pack.created', actorType: 'user', actorId: build.requestedByUserId,
					targetType: 'knowledge_pack', targetId: build.id, data: { teamId: build.teamId,
						sourceClosure: pack.manifest.sourceClosure, bookIds: build.bookIds, digest: saved.digest } });
				await context.checkpoint({ phase: 'knowledge.pack.completed', buildId: build.id,
					sourceClosure: pack.manifest.sourceClosure }, { kind: 'knowledge.pack.completed',
					data: { buildId: build.id, sourceClosure: pack.manifest.sourceClosure } });
				return { ok: true, buildId: build.id, sourceClosure: pack.manifest.sourceClosure,
					bookCount: pack.manifest.members.length, digest: saved.digest };
			} catch (error) {
				await store.updateKnowledgePackBuild(build.id, { expectedStatus: 'building', status: 'failed',
					error: error instanceof Error ? error.message : 'Knowledge-pack build failed.' });
				throw error;
			}
		},
	};
}

export function createKnowledgePackCleanupExecutor(options: any) {
	return {
		namespace: 'knowledge', operation: 'cleanup_packs',
		async run(input: any, context: any) {
			const store = options.controlPlaneStore;
			if (!store) throw new Error('Knowledge-pack cleanup requires a control-plane store.');
			const teamId = String(input?.teamId ?? '');
			if (!teamId) throw new Error('Knowledge-pack cleanup requires a team.');
			const now = String(input?.now ?? new Date().toISOString());
			const storage = createPrivateObjectStorage({ adapter: options.privateObjectStorage });
			let expired = 0;
			for (const build of await store.listKnowledgePackBuilds(teamId)) {
				if (build.status !== 'completed' || !build.artifact?.storageKey || !build.artifact?.expiresAt
					|| build.artifact.expiresAt > now) continue;
				await storage.delete(build.artifact.storageKey);
				if (await storage.get(build.artifact.storageKey)) throw new Error(`Knowledge-pack artifact ${build.id} remained after cleanup.`);
				const updated = await store.updateKnowledgePackBuild(build.id, { expectedStatus: 'completed', status: 'expired', artifact: {} });
				if (!updated.ok) continue;
				expired += 1;
				await store.recordAuditEvent({ eventType: 'knowledge.pack.expired', actorType: 'system', actorId: null,
					targetType: 'knowledge_pack', targetId: build.id, data: { teamId, publicationRevision: build.publicationRevision } });
			}
			await context.checkpoint({ phase: 'knowledge.pack.cleanup', teamId, expired },
				{ kind: 'knowledge.pack.cleanup', data: { teamId, expired } });
			return { ok: true, teamId, expired };
		},
	};
}
