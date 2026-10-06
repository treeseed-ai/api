import { describe,expect,it,vi } from 'vitest';
import { markManagedTeamLibraryMirrorKnownGood,reconcileManagedTeamLibrary } from '../../../../src/api/teams/managed-team-library-service.ts';
import { ControlPlaneStore } from '../../../../src/api/persistence/store.ts';
import { postgresGraph } from '../capacity/execution/graph/architecture/living/living-postgres-fixture.ts';

describe('managed Team Library readiness',()=>{
	it('native managed execution context denies malformed stored repository policy without credential delivery or persistent mutation',async()=>{
		const f=await postgresGraph();
		try{
			const store=new ControlPlaneStore({TREESEED_ENVIRONMENT:'test'},f.left);store.initializationPromise=Promise.resolve();
			const project=await store.ensureManagedTeamLibraryProject('team'),observed:unknown[]=[];
			for(const policy of [{visibility:'preview'},{visibility:null},{visibility:[]},{lifecycle:'overwrite'},{lifecycle:null},{lifecycle:7}]){
				const metadata={...project.metadata,library:{...project.metadata.library,owner:'example',repositoryPolicy:policy}};
				await f.left.pool.query('UPDATE projects SET metadata_json=$1 WHERE id=$2',[JSON.stringify(metadata),project.id]);
				const snapshot=async()=>({teams:(await f.right.pool.query('SELECT * FROM teams ORDER BY id')).rows,projects:(await f.right.pool.query('SELECT * FROM projects ORDER BY id')).rows,
					credentials:(await f.right.pool.query('SELECT * FROM remote_credential_deliveries ORDER BY id')).rows,audits:(await f.right.pool.query('SELECT * FROM audit_events ORDER BY id')).rows});
				const before=await snapshot();let cause:unknown;try{await reconcileManagedTeamLibrary(store,'team',{});}catch(error){cause=error;}observed.push(cause);
				expect(await snapshot()).toEqual(before);
			}
			for(const cause of observed)expect(cause).toMatchObject({message:'Managed Team Library repository policy is invalid.'});
		}finally{await f.close();}
	});
	it('managed execution context refuses missing project read-back before publishing team library metadata',async()=>{
		const store=new ControlPlaneStore({}, {prepare(){throw new Error('Unexpected unit SQL');}});
		vi.spyOn(store,'ensureInitialized').mockResolvedValue(undefined);
		vi.spyOn(store,'getProjectByTeamAndSlug').mockResolvedValue(null);
		const create=vi.spyOn(store,'createProject').mockResolvedValue(null);
		const first=vi.spyOn(store,'first').mockResolvedValue({metadata_json:'{}'}),run=vi.spyOn(store,'run').mockResolvedValue({});
		await expect(store.ensureManagedTeamLibraryProject('team')).rejects.toThrow('Managed Team Library project could not be read back.');
		expect(create).toHaveBeenCalledOnce();expect(first).not.toHaveBeenCalled();expect(run).not.toHaveBeenCalled();
	});
	it('native managed execution context retains moved project and entitlement rows without false team metadata before current-authority retry',async()=>{
		const f=await postgresGraph();
		try{
			const store=new ControlPlaneStore({TREESEED_ENVIRONMENT:'test'},f.left);store.initializationPromise=Promise.resolve();
			const team=(await f.right.pool.query("SELECT * FROM teams WHERE id='team'")).rows;
			await f.left.pool.query(`CREATE FUNCTION moved_library_project() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.id := 'interrupted-' || NEW.id; RETURN NEW; END $$;
				CREATE TRIGGER moved_library_project BEFORE INSERT ON projects FOR EACH ROW EXECUTE FUNCTION moved_library_project()`);
			let cause:unknown;try{await store.ensureManagedTeamLibraryProject('team');}catch(error){cause=error;}
			const projects=(await f.right.pool.query('SELECT * FROM projects ORDER BY id')).rows;
			const entitlements=(await f.right.pool.query('SELECT * FROM entitlements ORDER BY id')).rows;
			expect(projects).toHaveLength(1);expect(projects[0].id).toMatch(/^interrupted-/);
			expect(entitlements).toHaveLength(1);expect(projects[0].id).toBe(`interrupted-${entitlements[0].project_id}`);
			expect((await f.right.pool.query("SELECT * FROM teams WHERE id='team'")).rows).toEqual(team);
			await f.left.pool.query('DROP TRIGGER moved_library_project ON projects; DROP FUNCTION moved_library_project()');
			// The original failed creation is not relabelled successful. The next
			// call resolves the different, currently stored project by its slug.
			const result=await store.ensureManagedTeamLibraryProject('team');expect(result.id).toBe(projects[0].id);
			expect((await f.right.pool.query('SELECT * FROM projects ORDER BY id')).rows).toEqual(projects);
			expect((await f.right.pool.query('SELECT * FROM entitlements ORDER BY id')).rows).toEqual(entitlements);
			expect((await f.right.pool.query("SELECT * FROM teams WHERE id='team'")).rows).toEqual(team);
			expect(await f.snapshot()).toEqual({nodes:[],edges:[],revisions:[],assignments:[],reservations:[]});
			expect(cause).toMatchObject({message:'Managed Team Library project could not be read back.'});
		}finally{await f.close();}
	});
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
