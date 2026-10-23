import { expect, it } from 'vitest';
import { closeoutDatabase, now, reportRef, reportResult } from '../architecture/closeout-sql-fixture.ts';
import { advanceLivingWorkday } from '../../../../../../../src/api/capacity/services/capacity/workdays/lifecycle/living-workday-lifecycle.ts';
import { verifyNativeReporterCloseout } from '../../../../../../acceptance/execution-inventory.ts';

// Original lifecycle, SQL and repositories. Completed assignments and integration
// receipts below are controlled inputs, not executed models or content read-back.
it.each(['complete', 'missing-integration', 'pending', 'unsettled'])('requires all project report receipts and settlements at the owning SQL boundary: %s', async mode => {
	const f = await closeoutDatabase();
	try {
		const otherReference = { ...reportRef, projectId: 'other', path: 'notes/other-workday-report.mdx' };
		const otherResult = { ...reportResult, id: 'other-result', assignmentId: 'other-assignment', references: [otherReference] };
		await f.query(`INSERT INTO execution_nodes (id,team_id,project_id,workday_id,kind,source_ref_json,rule_revision,
			node_revision,agent_class,status,graph_revision_created,graph_revision_updated,created_at,updated_at)
			VALUES ('z-other-report','team','other','workday','reporting','{}',1,1,'closeout-author',?,1,1,?,?)`,
			[mode === 'pending' ? 'running' : 'completed', now, now]);
		await f.query(`INSERT INTO capacity_provider_assignments (id,membership_id,team_id,project_id,capacity_provider_id,
			project_agent_class_id,work_day_id,mode,status,execution_node_id,assignment_result_json,completed_at,created_at,updated_at)
			VALUES ('other-assignment','membership','team','other','provider','closeout-author','workday','acting',
			'completed','z-other-report',?,?,?,?)`, [JSON.stringify(otherResult), now, now, now]);
		if (mode !== 'missing-integration') await f.query(`INSERT INTO audit_events
			(id,actor_type,event_type,target_type,target_id,data_json,created_at) VALUES
			('other-integrated','service','assignment.content.integrated','capacity_provider_assignment','other-assignment',?,?)`,
			[JSON.stringify({ resultId: otherResult.id, references: otherResult.references, publication: false }), now]);
		if (mode === 'unsettled') await f.query("UPDATE capacity_reservations SET state='reserved'");
		const snapshot = async () => ({ assignments: (await f.query('SELECT * FROM capacity_provider_assignments ORDER BY id')).rows,
			nodes: (await f.query('SELECT * FROM execution_nodes ORDER BY id')).rows,
			audits: (await f.query('SELECT * FROM audit_events ORDER BY id')).rows,
			reservations: (await f.query('SELECT * FROM capacity_reservations ORDER BY id')).rows });
		const before = await snapshot(), run = (await f.reads.get('team', 'workday'))!;
		if (mode === 'missing-integration') {
			// Recovery attempts the original content read-back. This controlled
			// missing binding must deny it and retain the entire unfinished run.
			await expect(advanceLivingWorkday({ ...f.store, getProjectTreeDxLibrary: async () => null }, run, now))
				.rejects.toMatchObject({ code: 'assignment_content_repository_mismatch' });
			expect(await snapshot()).toEqual(before); expect(await f.reads.get('team', 'workday')).toEqual(run); return;
		}
		const result = await advanceLivingWorkday(f.store, run, now);
		expect(result.status).toBe(mode === 'complete' ? 'completed' : 'running');
		expect(await snapshot()).toEqual(before);
		const retained = (await f.reads.get('team', 'workday'))!;
		if (mode === 'complete') {
			expect(retained.parameters.appliedPlan).toMatchObject({ state: 'ended', reportRef });
			expect(() => verifyNativeReporterCloseout(retained, before.assignments, before.nodes, before.audits)).not.toThrow();
			const altered = structuredClone(before.audits); altered.find(row=>row.target_id === otherResult.assignmentId)!.data_json = '{}';
			expect(() => verifyNativeReporterCloseout(retained, before.assignments, before.nodes, altered)).toThrow('ACCEPTANCE_NATIVE_REPORT_CLOSEOUT');
			expect(() => verifyNativeReporterCloseout(retained, before.assignments.filter(row=>row.id !== otherResult.assignmentId), before.nodes, before.audits)).toThrow('ACCEPTANCE_NATIVE_REPORT_CLOSEOUT');
			expect((await advanceLivingWorkday(f.store, retained, now)).changed).toBe(false);
		} else expect(retained.parameters.appliedPlan).not.toHaveProperty('reportRef');
		expect(await snapshot()).toEqual(before);
	} finally { await f.db.close(); }
});
