import { decodeCapacityPageCursor, encodeCapacityPageCursor, normalizeCapacityPageLimit } from '@treeseed/sdk/capacity-pagination';
import { resolveGitHubSourceAuthority } from '../../../../../security/provider-credential-authority.ts';
import { selectAssignmentSourceRepository } from '../../../../capacity/services/capacity/assignments/context/source-repository.ts';
import { reconcileRepositoryCheckRun } from '../../github-webhook-service.ts';
import { authorizeCapacityTeam, type CapacityPrincipal } from '../capacity-authorization.ts';
import { CapacityOperationError } from '../capacity-operation-error.ts';

type Row = Record<string, unknown>;
function metadata(row: Row): Row {
	try { return JSON.parse(String(row.metadata_json ?? '{}')) as Row; }
	catch { throw new CapacityOperationError(503, 'workday_profile_metadata_invalid', 'Stored profile metadata is invalid.'); }
}
function profile(row: Row) {
	const value = metadata(row);
	return { allocationSetId: row.id, status: row.status, version: row.version, generation: value.repositoryProfile, profile: value.workdayProfile };
}

export function createWorkdayProfileService(store: any) {
	return {
		async profilesList(principal: CapacityPrincipal, teamId: string, query: Row) {
			await authorizeCapacityTeam(store, principal, teamId, 'projects:read:team');
			let cursor; let limit;
			try { cursor = decodeCapacityPageCursor(query.cursor); limit = Math.min(100, normalizeCapacityPageLimit(query.limit)); }
			catch { throw new CapacityOperationError(400, 'capacity_page_invalid', 'Invalid profile page cursor or limit.'); }
			const status = String(query.status ?? 'active');
			if (!['active', 'archived', 'superseded'].includes(status)) throw new CapacityOperationError(400, 'workday_profile_status_invalid', 'Invalid profile status.');
			const rows: Row[] = await store.all(`SELECT * FROM capacity_allocation_sets WHERE team_id=? AND status=?
				AND jsonb_exists(metadata_json::jsonb, 'repositoryProfile') ${cursor ? 'AND (created_at,id) > (?,?)' : ''} ORDER BY created_at,id LIMIT ?`,
				[teamId, status, ...(cursor ? [cursor.createdAt, cursor.id] : []), limit + 1]);
			const items = rows.slice(0, limit); const last = items.at(-1); const hasMore = rows.length > limit;
			return { items: items.map(profile), page: { limit, hasMore, nextCursor: hasMore && last
				? encodeCapacityPageCursor({ createdAt: last.created_at instanceof Date ? last.created_at.toISOString() : String(last.created_at), id: String(last.id) }) : null } };
		},
		async profilesShow(principal: CapacityPrincipal, teamId: string, profileId: string) {
			await authorizeCapacityTeam(store, principal, teamId, 'projects:read:team');
			const rows: Row[] = await store.all(`SELECT * FROM capacity_allocation_sets WHERE team_id=? AND status='active'
				AND (id=? OR metadata_json::jsonb->'repositoryProfile'->>'profileId'=?) ORDER BY created_at DESC LIMIT 2`, [teamId, profileId, profileId]);
			if (!rows.length) throw new CapacityOperationError(404, 'workday_profile_not_found', 'Accepted workday profile not found. Reconcile its project repository first.');
			if (rows.length > 1) throw new CapacityOperationError(409, 'workday_profile_ambiguous', 'Use the exact allocation-set identity to select this profile.');
			return profile(rows[0]!);
		},
		async profilesReconcile(principal: CapacityPrincipal, teamId: string, projectId: string) {
			await authorizeCapacityTeam(store, principal, teamId, 'teams:manage:team');
			const project: Row | null = await store.first('SELECT id FROM projects WHERE team_id=? AND (id=? OR slug=?)', [teamId, projectId, projectId]);
			if (!project) throw new CapacityOperationError(404, 'workday_repository_binding_missing', 'No source project belongs to this team.');
			const source = selectAssignmentSourceRepository(await store.listHubRepositories(String(project.id)));
			const binding = { ...source, publication_ref: source.ref.replace(/^refs\/heads\//u, '') };
			const credential = await resolveGitHubSourceAuthority({ store, teamId, owner: source.owner, repository: source.name });
			const base = `https://api.github.com/repos/${encodeURIComponent(String(binding.owner))}/${encodeURIComponent(String(binding.name))}`;
			const headers = { accept: 'application/vnd.github+json', authorization: `Bearer ${credential.token}`, 'user-agent': 'treeseed-workday-profile', 'x-github-api-version': '2022-11-28' };
			const read = async (url: string, stage: 'ref' | 'checks'): Promise<Row> => {
				const response = await fetch(url, { headers, redirect: 'error', signal: AbortSignal.timeout(15_000) });
				if (!response.ok) throw new CapacityOperationError(503, `workday_repository_${stage}_readback_failed`, `GitHub ${stage} read-back failed for ${binding.owner}/${binding.name} at ${binding.publication_ref} (HTTP ${response.status}). Verify the bound source repository and repository Contents/Checks read permissions.`);
				return await response.json() as Row;
			};
			const ref = await read(`${base}/git/ref/heads/${String(binding.publication_ref).split('/').map(encodeURIComponent).join('/')}`, 'ref');
			const commit = String((ref.object as Row | undefined)?.sha ?? '');
			if (!/^[a-f0-9]{40}$/u.test(commit)) throw new CapacityOperationError(503, 'workday_repository_ref_invalid', 'Repository did not return an exact publication commit.');
			const checks = await read(`${base}/commits/${commit}/check-runs?check_name=verify&filter=latest&per_page=100`, 'checks');
			const check = (Array.isArray(checks.check_runs) ? checks.check_runs as Row[] : []).find((entry) =>
				entry.name === 'verify' && entry.head_sha === commit && entry.status === 'completed' && entry.conclusion === 'success'
				&& (entry.app as Row | undefined)?.slug === 'github-actions');
			if (!check) throw new CapacityOperationError(409, 'workday_repository_check_required', 'The exact publication head needs a successful GitHub Actions verify check.');
			// Reuse authoritative check/ref/content read-back; this is not a synthetic webhook delivery.
			const receipts = await reconcileRepositoryCheckRun(store, { repository: { full_name: `${binding.owner}/${binding.name}` }, check_run: { id: check.id } }, { teamId, projectId: String(project.id), expectedCommit: commit });
			if (!Array.isArray(receipts)) throw new CapacityOperationError(409, 'workday_profile_not_reconciled', 'Publication head moved, its check is no longer eligible, or it has no workday profiles.');
			return { repository: `${binding.owner}/${binding.name}`, commit, receipts };
		},
	};
}
