import { describe, expect, it } from 'vitest';
import { dependencyPoll } from './dependency-poll-fixture.ts';
import { isDeepStrictEqual } from 'node:util';

describe('original provider poll and competing claim custody', () => {
	it('real original synthesis crossing unchanged availability expiry cannot create a late lease explanation or financial mutation on either requested lane', async () => {
		const observations=[];
		for(const boundary of ['synthesis','inventory','explanation-read'])for(const laneId of ['workday','foreign-lane']){
			if(boundary==='explanation-read'&&laneId==='workday')continue;
			const f=await dependencyPoll();try{
				expect((await f.evaluate()).eligible).toBe(true);
				const request={...f.request,laneId}, input=structuredClone(request), custody=await f.custody();
				const original=f.store.synthesizeProviderAssignments.bind(f.store), expiry=Date.parse(f.attempt.deadline);
				let synthesized:Awaited<ReturnType<typeof f.snapshot>>|undefined, calls=0;
				const crossExpiry=async()=>{calls++;synthesized=await f.snapshot();expect(Date.now()).toBeLessThan(expiry);
					while(Date.now()<expiry)await new Promise<void>(resolve=>setTimeout(resolve,expiry-Date.now()));
				};
				if(boundary==='synthesis')f.store.synthesizeProviderAssignments=async(principal,body)=>{
					const result=await original(principal,body);await crossExpiry();return result;
				};
				if(boundary==='inventory'){
					const all=f.store.all.bind(f.store);f.store.all=async(sql,params)=>{const rows=await all(sql,params);
						if(sql.includes("status IN ('pending', 'returned')"))await crossExpiry();return rows;};
				}
				if(boundary==='explanation-read'){
					const get=f.store.getProviderAssignment.bind(f.store);f.store.getProviderAssignment=async(team,id)=>{
						const row=await get(team,id);await crossExpiry();return row;};
				}
				let error:unknown, assigned=false;
				try{assigned=Boolean((await f.poll(request)).assignment);}catch(cause){error=cause;}
				const after=await f.snapshot(), row=await f.repository.get(f.principal.teamId,f.attempt.id);
				observations.push({boundary,laneId,calls,assigned,code:error&&typeof error==='object'&&'code' in error?error.code:null,
					status:row?.status,leaseAbsent:row?.leaseToken===null,postSynthesisUnchanged:isDeepStrictEqual(after,synthesized),
					custodyUnchanged:isDeepStrictEqual(await f.custody(),custody),inputUnchanged:isDeepStrictEqual(request,input)});
			}finally{await f.db.close();}
		}
		for(const observation of observations)expect(observation).toEqual({boundary:observation.boundary,laneId:observation.laneId,calls:1,assigned:false,
			code:'provider_synthesis_window_expired',status:'pending',leaseAbsent:true,postSynthesisUnchanged:true,custodyUnchanged:true,inputUnchanged:true});
	});
	it('original synthesis recovery and lease retain the exact admitted attempt and both dependency results within the original authority deadline', async () => {
		const f = await dependencyPoll(); try {
			const before = await f.custody(), calledAt = Date.now(), result = await f.poll(), receivedAt = Date.now();
			expect(result.assignment).toMatchObject({ id: f.attempt.id, status: 'leased', leaseState: 'leased', runnerId: f.request.runnerId });
			expect(result.leaseToken).toBeTruthy(); expect(result.assignment?.leaseToken).toBe(result.leaseToken);
			expect(result.assignment?.assignmentAttempt).toEqual(f.attempt); expect(result.assignment?.workspaceContext.predecessorResults).toEqual([f.actor, f.review]);
			const expiry = Date.parse(result.assignment?.leaseExpiresAt ?? ''); expect(expiry).toBeGreaterThan(calledAt); expect(expiry).toBeLessThanOrEqual(Date.parse(f.attempt.deadline));
			expect(receivedAt).toBeLessThanOrEqual(Date.parse(f.attempt.deadline)); expect(await f.custody()).toEqual(before);
			const leased = await f.repository.get(f.principal.teamId, f.attempt.id); expect(leased?.leaseToken).toBe(result.leaseToken);
		} finally { await f.db.close(); }
	});
	it('concurrent original polls grant one lease token and runner without duplicating or rewriting the admitted dependency reservation', async () => {
		const f = await dependencyPoll(); try {
			const before = await f.custody();
			const results = await Promise.all([f.poll(), f.poll({ ...f.request, runnerId: 'competing-runner' })]);
			const winners = results.filter(result => result.assignment); expect(winners).toHaveLength(1);
			const winner = winners[0]!; const read = await f.repository.get(f.principal.teamId, f.attempt.id);
			expect(read?.leaseToken).toBe(winner.leaseToken); expect(read?.runnerId).toBe(winner.assignment?.runnerId);
			for (const loser of results.filter(result => !result.assignment)) expect(loser.leaseToken).toBeNull();
			expect(await f.custody()).toEqual(before);
		} finally { await f.db.close(); }
	});
	it('foreign missing closed and malformed availability authorities deny original poll before any lease or synthesis audit mutation', async () => {
		for (const mode of ['team', 'member', 'provider', 'missing', 'closed', 'malformed'] as const) {
			const f = await dependencyPoll(); try {
				expect((await f.evaluate()).eligible).toBe(true); const principal = { ...f.principal }, request = { ...f.request };
				if (mode === 'team') principal.teamId = 'foreign-team'; if (mode === 'member') principal.membershipId = 'foreign-member';
				if (mode === 'provider') principal.capacityProviderId = 'foreign-provider'; if (mode === 'missing') request.providerSessionId = 'missing';
				if (mode === 'closed') await f.query("UPDATE capacity_provider_availability_sessions SET status='closed' WHERE id='session'");
				if (mode === 'malformed') await f.query("UPDATE capacity_provider_availability_sessions SET available_from='malformed' WHERE id='session'");
				const before = await f.snapshot(); await expect(f.poll(request, principal)).rejects.toThrow(); expect(await f.snapshot()).toEqual(before);
			} finally { await f.db.close(); }
		}
	});
	it('late native lease update interruption preserves original pending custody and synthesis history before identical-input bounded retry', async () => {
		const f = await dependencyPoll(); try {
			const original = await f.custody();
			await f.db.exec(`CREATE FUNCTION interrupt_dependency_lease() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
				IF NEW.status='leased' THEN RAISE EXCEPTION 'dependency lease interruption'; END IF; RETURN NEW; END $$;
				CREATE TRIGGER interrupt_dependency_lease BEFORE UPDATE ON capacity_provider_assignments FOR EACH ROW EXECUTE FUNCTION interrupt_dependency_lease();`);
			await expect(f.poll()).rejects.toThrow('dependency lease interruption');
			expect(await f.custody()).toEqual(original); expect((await f.repository.get(f.principal.teamId, f.attempt.id))?.status).toBe('pending');
			const history = (await f.query('SELECT * FROM capacity_audit_events ORDER BY id')).rows; expect(history.length).toBeGreaterThan(0);
			await f.db.exec('DROP TRIGGER interrupt_dependency_lease ON capacity_provider_assignments; DROP FUNCTION interrupt_dependency_lease();');
			expect(Date.now()).toBeLessThan(Date.parse(f.attempt.deadline)); const retry = await f.poll(); expect(retry.assignment?.id).toBe(f.attempt.id);
			expect(await f.custody()).toEqual(original); const after = (await f.query('SELECT * FROM capacity_audit_events ORDER BY id')).rows;
			for (const row of history) expect(after).toContainEqual(row);
		} finally { await f.db.close(); }
	});
});
