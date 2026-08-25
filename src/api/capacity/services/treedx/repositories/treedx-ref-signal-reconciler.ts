import type { CapacityGovernanceDatabase } from '../../../database.ts';
import { projectLibraryPath, resolveKnowledgeGatewayConnection } from '../../../../knowledge/gateway-treedx-connection.ts';
import { projectTreeDxCommitSignals } from './treedx-change-projector.ts';

type Row = Record<string, unknown>;
function object(value: unknown): Row { if (value && typeof value === 'object' && !Array.isArray(value)) return value as Row; if (typeof value === 'string') try { return object(JSON.parse(value)); } catch { return {}; } return {}; }
function text(...values: unknown[]) { return String(values.find((value) => typeof value === 'string' && value.trim()) ?? '').trim(); }
function paths(value: unknown) { return Array.isArray(value) ? value.flatMap((entry) => { const row = object(entry); const path = text(row.path, row.filePath, row.value); return path ? [path] : []; }) : []; }

/** Projects commits not created by a Treeseed workspace into the same durable signal stream. */
export async function reconcileTreeDxRefSignals(database: CapacityGovernanceDatabase, projectId: string, createdAt = new Date().toISOString()) {
	let connection = await resolveKnowledgeGatewayConnection(database, { projectId, write: false, relationPaths: true });
	if (!connection) throw new Error(`TreeDX repository is unavailable for project ${projectId}.`);
	const listed = await connection.client.listRepositoryPaths({ repoId: connection.repositoryId, ref: connection.baseRef, paths: [projectLibraryPath(connection.contentPath, '**')], kinds: ['blob'], limit: 1, allowProtected: true });
	const currentRef = text(listed.resolvedRef);
	if (!/^[a-f0-9]{40}$/u.test(currentRef)) throw new Error(`TreeDX did not resolve an immutable content ref for project ${projectId}.`);
	const key = `${projectId}:${connection.repositoryId}:${connection.baseRef}`;
	const state = await database.first(`SELECT * FROM runtime_records WHERE record_type = 'treedx-signal-ref' AND record_key = ? ORDER BY updated_at DESC LIMIT 1`, [key]);
	const previousRef = text(object(state?.payload_json).resolvedRef);
	if (previousRef === currentRef) return { projectId, previousRef, currentRef, changedPaths: [], initialized: true };
	let changedPaths: string[] = [];
	if (/^[a-f0-9]{40}$/u.test(previousRef)) {
		// TreeDX authorizes every side of a diff independently. The initial branch-scoped
		// connection is sufficient to discover the current commit, then the immutable
		// comparison refs must be included explicitly in the short-lived token.
		connection = await resolveKnowledgeGatewayConnection(database, {
			projectId,
			write: false,
			relationPaths: true,
			readRefs: [previousRef, currentRef],
		});
		if (!connection) throw new Error(`TreeDX repository is unavailable for project ${projectId}.`);
		let cursor: string | null = null;
		do {
			const result = await connection.client.queryRepository({ repoId: connection.repositoryId, ref: currentRef, baseRef: previousRef, type: 'changed_path', paths: [projectLibraryPath(connection.contentPath, '**')], limit: 400, cursor, allowProtected: true });
			changedPaths.push(...paths(result.results)); cursor = result.page?.hasMore ? result.page.nextCursor : null;
		} while (cursor);
		changedPaths = [...new Set(changedPaths)].sort();
		if (changedPaths.length) await projectTreeDxCommitSignals(database, { projectId, commitSha: currentRef, immutableRef: currentRef, changedPaths, changeSummary: `Repository content changed from ${previousRef.slice(0, 12)} to ${currentRef.slice(0, 12)}.`, actorType: 'service', actorId: 'treedx-ref-reconciler', createdAt });
	}
	const payload = JSON.stringify({ projectId, repositoryId: connection.repositoryId, ref: connection.baseRef, resolvedRef: currentRef, previousRef: previousRef || null, changedPaths });
	if (state) await database.run(`UPDATE runtime_records SET status = 'ready',schema_version = 1,payload_json = ?,meta_json = '{}',updated_at = ? WHERE id = ?`, [payload, createdAt, state.id]);
	else await database.run(`INSERT INTO runtime_records (record_type,record_key,lookup_key,secondary_key,status,schema_version,created_at,updated_at,payload_json,meta_json) VALUES ('treedx-signal-ref',?,?,?,'ready',1,?,?,?,'{}')`, [key, projectId, connection.repositoryId, createdAt, createdAt, payload]);
	return { projectId, previousRef: previousRef || null, currentRef, changedPaths, initialized: Boolean(previousRef) };
}
