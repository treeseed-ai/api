import { DEFAULT_WORKDAY_POLICY, workdayPolicySchema, workdayProfileSchema, type WorkdayProfile } from '@treeseed/sdk/agent-capacity';
import { authorizeCapacityTeam, type CapacityPrincipal } from '../capacity-authorization.ts';
import { CapacityOperationError } from '../capacity-operation-error.ts';

type Row = Record<string, unknown>;

/** Team metadata owns the policy; workdays retain immutable resolved snapshots. */
export async function readTeamWorkdayProfile(store: any, teamId: string): Promise<WorkdayProfile> {
	const row = await store.first('SELECT metadata_json FROM teams WHERE id=?', [teamId]);
	if (!row) throw new CapacityOperationError(404, 'workday_team_not_found', 'Workday team not found.');
	try {
		const metadata: Row = row.metadata_json ? JSON.parse(String(row.metadata_json)) : {};
		const stored = metadata.workdayProfile ?? { revision: 1, policy: DEFAULT_WORKDAY_POLICY };
		if (!stored || typeof stored !== 'object' || Array.isArray(stored)) throw new Error('Invalid policy');
		if (Object.keys(stored).some(key => key !== 'revision' && key !== 'policy')) throw new Error('Unexpected policy fields');
		return workdayProfileSchema.parse({ ...(stored as Row), id: 'default', teamId });
	} catch {
		throw new CapacityOperationError(503, 'workday_profile_invalid', 'The team workday policy is invalid; repair it before admitting work.');
	}
}

export function createWorkdayProfileService(store: any) {
	const requireDefault = (profileId: string) => {
		if (profileId !== 'default') throw new CapacityOperationError(404, 'workday_profile_not_found', 'Use the team default workday policy.');
	};
	return {
		async profilesList(principal: CapacityPrincipal, teamId: string, query: Row) {
			await authorizeCapacityTeam(store, principal, teamId, 'projects:read:team');
			if (query.cursor) throw new CapacityOperationError(400, 'capacity_page_invalid', 'The single team policy has no continuation cursor.');
			return { items: [await readTeamWorkdayProfile(store, teamId)], page: { limit: Number(query.limit ?? 1), hasMore: false, nextCursor: null } };
		},
		async profilesShow(principal: CapacityPrincipal, teamId: string, profileId: string) {
			await authorizeCapacityTeam(store, principal, teamId, 'projects:read:team');
			requireDefault(profileId);
			return readTeamWorkdayProfile(store, teamId);
		},
		async profilesUpdate(principal: CapacityPrincipal, teamId: string, profileId: string, body: Row, ifMatch?: string) {
			await authorizeCapacityTeam(store, principal, teamId, 'teams:manage:team');
			requireDefault(profileId);
			const current = await readTeamWorkdayProfile(store, teamId);
			if (Number(ifMatch?.replaceAll('"', '')) !== current.revision) throw new CapacityOperationError(
				412, 'workday_profile_precondition_failed', 'The team policy changed; inspect it before updating.');
			const validation = workdayPolicySchema.safeParse(body.policy);
			if (!validation.success || Object.keys(body).some(key => key !== 'policy')) throw new CapacityOperationError(
				400, 'workday_profile_policy_invalid', 'Provide only the canonical allocation policy.');
			const stored = { revision: current.revision + 1, policy: validation.data };
			const updated = await store.first(`UPDATE teams SET metadata_json=jsonb_set(
				COALESCE(NULLIF(metadata_json,'')::jsonb,'{}'::jsonb),'{workdayProfile}',?::jsonb,true)::text,updated_at=?
				WHERE id=? AND COALESCE((NULLIF(metadata_json,'')::jsonb->'workdayProfile'->>'revision')::integer,1)=?
				RETURNING id`, [JSON.stringify(stored), new Date().toISOString(), teamId, current.revision]);
			if (!updated) throw new CapacityOperationError(412, 'workday_profile_precondition_failed', 'The team policy changed concurrently.');
			return workdayProfileSchema.parse({ id: 'default', teamId, ...stored });
		},
	};
}
