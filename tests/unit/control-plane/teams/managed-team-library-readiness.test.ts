import { describe,expect,it } from 'vitest';
import { markManagedTeamLibraryMirrorKnownGood } from '../../../../src/api/teams/managed-team-library-service.ts';

describe('managed Team Library readiness',()=>{
	it('becomes known-good only for the exact verified canonical R2 mirror',async()=>{
		const runs:Array<{query:string;params:unknown[]}>=[];
		const store:any={
			async getProject(){return {id:'team-project',metadata:{kind:'system-team-library',library:{status:'replicating'},provisioning:{state:'replicating'}}};},
			async getProjectTreeDxLibrary(){return {metadata:{resolvedRef:'a'.repeat(40)}};},
			async getTeam(){return {metadata:{teamLibrary:{projectId:'team-project',state:'replicating'}}};},
			async run(query:string,params:unknown[]){runs.push({query,params});},
		};
		expect(await markManagedTeamLibraryMirrorKnownGood(store,{teamId:'team',projectId:'team-project',commitSha:'b'.repeat(40),r2Receipt:{schemaVersion:'treeseed.treedx-r2-file-mirror/v2',commitSha:'b'.repeat(40)}})).toBe(false);
		expect(runs).toHaveLength(0);
		expect(await markManagedTeamLibraryMirrorKnownGood(store,{teamId:'team',projectId:'team-project',commitSha:'a'.repeat(40),r2Receipt:{schemaVersion:'treeseed.treedx-r2-file-mirror/v2',commitSha:'a'.repeat(40)}})).toBe(true);
		expect(runs).toHaveLength(2);
		expect(String(runs[0]?.params[0])).toContain('known-good');
	});
});
