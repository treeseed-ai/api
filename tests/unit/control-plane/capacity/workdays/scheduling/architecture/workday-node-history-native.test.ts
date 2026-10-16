import{expect,it}from'vitest';
import{appliedWorkdaySchema}from'@treeseed/sdk/agent-capacity';
import{workdayStartDatabase}from'./workday-start-fixture.ts';
import{expectNodeBirthHistory,expectWorkdayLifecycleHistory}from'./node-birth-history.ts';

	it('native original planning ticks retain an interrupted generation and repeat beyond two rounds without duplicate nodes events or financial writes', async () => {
		const f = await workdayStartDatabase(); try {
			const input = structuredClone(f.intent), current = await f.publicService.profilesShow(f.principal, 'team', 'default');
			// A fresh test-owned policy BEFORE admission, not an extension of an
			// admitted deadline. Node states and tick clocks below are INPUTS;
			// no model, published contribution or measured usage is fabricated.
			const policy = { ...current.policy, durationSeconds: input.durationSeconds, planningPercent: 100,
				planningTurnMaximumSeconds: 10, maximumConcurrency: 1 };
			await f.publicService.profilesUpdate(f.principal, 'team', 'default', { policy }, String(current.revision));
			const planned = await f.preflight(), receipt = await f.start(planned);
			const initial = await f.store.getCapacityWorkdayRun('team', receipt.workdayId);
			if (!initial) throw new Error('Original native started run required');
			const originalPlan = appliedWorkdaySchema.parse(initial.parameters.appliedPlan), initialTruth = await f.snapshot();
			expect(originalPlan.policySnapshot).toEqual(policy); expect(originalPlan.planningRounds).toHaveLength(1);
			const nativePlan = async () => {
				const run = await f.store.getCapacityWorkdayRun('team', receipt.workdayId);
				if (!run) throw new Error('Original native run missing after tick');
				return appliedWorkdaySchema.parse(run.parameters.appliedPlan);
			};
			for (const ordinal of [2, 3, 4]) {
				const beforePlan = await nativePlan(), prior = beforePlan.planningRounds.at(-1)!;
				const now = new Date(Date.parse(originalPlan.startsAt) + (ordinal - 1) * 10_000).toISOString();
				for (const id of prior.assignmentIds) await f.query("UPDATE execution_nodes SET status='completed',updated_at=? WHERE team_id=? AND id=?", [now, 'team', id]);
				const key = `native-planning-round-${ordinal}`;
				if (ordinal === 2) {
					// Failure occurs AFTER original plan/graph writes but BEFORE the
					// tick receipt. Retain that real partial state; do not claim a
					// whole-workflow rollback or erase it to make retry pass.
					await f.db.exec(`CREATE FUNCTION planning_tick_failure() RETURNS trigger LANGUAGE plpgsql AS $$
						BEGIN IF NEW.event_type='workday.tick' THEN RAISE EXCEPTION 'allocated tick failure' USING ERRCODE='P0001'; END IF; RETURN NEW; END $$;
						CREATE TRIGGER planning_tick_failure BEFORE INSERT ON capacity_workday_events FOR EACH ROW EXECUTE FUNCTION planning_tick_failure();`);
					await expect(f.store.tickCapacityWorkdayRun('team', receipt.workdayId, now, key)).rejects.toMatchObject({ code: 'P0001' });
					const interrupted = await f.snapshot(), interruptedPlan = await nativePlan();
					expect(interruptedPlan.planningRounds).toHaveLength(ordinal);
					expect(interrupted.events.slice(0,initialTruth.events.length)).toEqual(initialTruth.events); expect(interrupted.events.filter(event=>event.event_type!=='execution.node.state'&&event.event_type!=='workday.lifecycle.changed')).toEqual(initialTruth.events.filter(event=>event.event_type!=='execution.node.state'&&event.event_type!=='workday.lifecycle.changed'));expect(expectWorkdayLifecycleHistory(interrupted)).toHaveLength(ordinal);const observed=interrupted.events.filter(event=>event.event_type==='workday.lifecycle.changed').at(-1)!;expect(JSON.parse(String(observed.context_json))).toEqual({previousStatus:'running',status:'running',previousPlan:beforePlan,plan:interruptedPlan}); expectNodeBirthHistory(interrupted);
					expect(interrupted.assignments).toEqual([]); expect(interrupted.reservations).toEqual([]);
					expect(interrupted.usage).toEqual([]); expect(interrupted.ledger).toEqual([]);
					await f.db.exec('DROP TRIGGER planning_tick_failure ON capacity_workday_events; DROP FUNCTION planning_tick_failure();');
					expect(await f.all("SELECT tgname FROM pg_trigger WHERE tgname='planning_tick_failure'")).toEqual([]);
					expect(await f.all("SELECT proname FROM pg_proc WHERE proname='planning_tick_failure'")).toEqual([]);
					expect(await f.snapshot()).toEqual(interrupted);
				}
				const tick = await f.store.tickCapacityWorkdayRun('team', receipt.workdayId, now, key), held = await f.snapshot();
				const next = await nativePlan();
				expect(next.planningRounds.map(round => round.round)).toEqual(Array.from({ length: ordinal }, (_, index) => index + 1));
				expect(next.planningRounds.slice(0, -1).every(round => round.state === 'complete')).toBe(true);
				expect(next.planningRounds.at(-1)).toMatchObject({ round: ordinal, state: 'active', startedAt: now });
				expect(next.startsAt).toBe(originalPlan.startsAt); expect(next.endsAt).toBe(originalPlan.endsAt);
				expect(next.policyRevision).toBe(originalPlan.policyRevision); expect(next.policySnapshot).toEqual(originalPlan.policySnapshot);
				const ids = next.planningRounds.flatMap(round => round.assignmentIds);
				expect(new Set(ids).size).toBe(ids.length); expect(held.nodes.map(node => node.id).sort()).toEqual([...ids].sort());
				const newest = next.planningRounds.at(-1)!;
				for (const id of newest.assignmentIds) {
					expect(held.nodes.find(node => node.id === id)).toMatchObject({ status: 'ready', kind: 'planning', workday_id: receipt.workdayId,
						project_id: 'project', agent_class: f.definition.agentClass });
					expect(held.edges.filter(edge => edge.to_node_id === id).map(edge => edge.from_node_id).sort()).toEqual([...prior.assignmentIds].sort());
				}
				expect(held.events.filter(event => event.event_type === 'workday.tick')).toHaveLength(ordinal - 1);
				expect(held.events.slice(0, initialTruth.events.length)).toEqual(initialTruth.events); expectNodeBirthHistory(held);expect(expectWorkdayLifecycleHistory(held)).toHaveLength(ordinal);
				expect(held.receipts).toEqual(initialTruth.receipts); expect(held.workdays).toHaveLength(1);
				expect(held.assignments).toEqual([]); expect(held.reservations).toEqual([]); expect(held.usage).toEqual([]); expect(held.ledger).toEqual([]);
				expect(await f.store.tickCapacityWorkdayRun('team', receipt.workdayId, now, key)).toEqual(tick);
				expect(await f.snapshot()).toEqual(held);
			}
			// Exact original tail: no whole turn fits. Expiry closes rather than
			// extending the deadline or publishing an empty success/report.
			const last = (await nativePlan()).planningRounds.at(-1)!;
			for (const id of last.assignmentIds) await f.query("UPDATE execution_nodes SET status='completed' WHERE team_id=? AND id=?", ['team', id]);
			const tail = new Date(Date.parse(originalPlan.endsAt) - 9_999).toISOString();
			await f.store.tickCapacityWorkdayRun('team', receipt.workdayId, tail, 'native-planning-tail');
			expect((await nativePlan()).planningRounds).toHaveLength(4);
			await f.store.tickCapacityWorkdayRun('team', receipt.workdayId, originalPlan.endsAt, 'native-planning-expiry');
			expect(await nativePlan()).toMatchObject({ state: 'closing', endsAt: originalPlan.endsAt, planningRounds: expect.arrayContaining([expect.objectContaining({ round: 4 })]) });
			expect((await nativePlan()).planningRounds).toHaveLength(4); expect(f.intent).toEqual(input);
			const final = await f.snapshot(); expect(final.usage).toEqual([]); expect(final.ledger).toEqual([]);
		} finally { await f.close(); }
	});

it('original native planning closeout observes every unclaimed cancellation before exact tick replay without changing the original deadline or financial authority',async()=>{
 const f=await workdayStartDatabase();try{
  const planned=await f.preflight(),started=await f.start(planned),run=await f.store.getCapacityWorkdayRun('team',started.workdayId);if(!run)throw new Error('Original native workday required');
  const plan=appliedWorkdaySchema.parse(run.parameters.appliedPlan),before=await f.snapshot();expectNodeBirthHistory(before);expect(before.nodes.length).toBeGreaterThan(0);expect(before.nodes.every(node=>node.status==='ready'&&node.kind==='planning')).toBe(true);
  const tick=await f.store.tickCapacityWorkdayRun('team',started.workdayId,plan.endsAt,'native-node-closeout'),after=await f.snapshot();
  expect(after.nodes.map(node=>node.id).sort()).toEqual(before.nodes.map(node=>node.id).sort());expect(after.nodes.every(node=>node.status==='cancelled')).toBe(true);expectNodeBirthHistory(after);
  const cancelled=after.events.filter(event=>event.event_type==='execution.node.state'&&JSON.parse(String(event.context_json)).status==='cancelled');expect(cancelled).toHaveLength(before.nodes.length);
  for(const node of before.nodes){const observations=cancelled.filter(event=>JSON.parse(String(event.context_json)).nodeId===node.id);expect(observations).toHaveLength(1);expect(JSON.parse(String(observations[0]!.context_json))).toMatchObject({nodeId:node.id,nodeRevision:node.node_revision,status:'cancelled',previousStatus:node.status});}
  const retained=await f.store.getCapacityWorkdayRun('team',started.workdayId);expect(appliedWorkdaySchema.parse(retained!.parameters.appliedPlan).endsAt).toBe(plan.endsAt);expect(after.assignments).toEqual(before.assignments);expect(after.reservations).toEqual(before.reservations);expect(after.usage).toEqual(before.usage);expect(after.ledger).toEqual(before.ledger);
  expect(await f.store.tickCapacityWorkdayRun('team',started.workdayId,plan.endsAt,'native-node-closeout')).toEqual(tick);expect(await f.snapshot()).toEqual(after);
 }finally{await f.close();}
 // Original native SQL, public owning tick and controlled clock input; no actual model workday is claimed.
});
