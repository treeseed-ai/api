import { describe,expect,it,vi } from 'vitest';
import { listProjectsForPrincipalMethod } from '../../../../../src/api/store/projects/queries/identity/list-projects-for-principal.ts';

describe('project inventory access',()=>{
	it('lets a market administrator discover the complete project inventory',async()=>{
		const all=vi.fn().mockResolvedValue([{id:'project-a',team_id:'team-a',slug:'project-a',name:'Project A',metadata_json:'{}'}]);
		const store={ensureInitialized:vi.fn(),all,teamIdsForPrincipal:vi.fn()};
		const projects=await listProjectsForPrincipalMethod.call(store as never,{id:'acceptance',roles:['market_admin']});
		expect(projects).toEqual([expect.objectContaining({id:'project-a',teamId:'team-a'})]);
		expect(all).toHaveBeenCalledWith('SELECT * FROM projects ORDER BY created_at ASC');
		expect(store.teamIdsForPrincipal).not.toHaveBeenCalled();
	});
});
