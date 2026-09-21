/** Metadata-only graph admission evidence; never include prompts, credentials or context bodies. */
export async function communicationSchedulingDiagnostics(store: any, teamId: string, executionId: string) {
	try { return await schedulingDiagnostics(store, teamId, executionId); }
	catch { return { executionId, status: 'unavailable', code: 'communication_scheduling_diagnostics_unavailable' }; }
}

async function schedulingDiagnostics(store: any, teamId: string, executionId: string) {
	if (!executionId) return null;
	const run = await store.first('SELECT id,status,execution_mode FROM capacity_workday_runs WHERE id=? AND team_id=?', [executionId, teamId]);
	if (!run) return null;
	const session = await store.first('SELECT id,status FROM workday_planning_sessions WHERE workday_run_id=? AND team_id=?', [executionId, teamId]);
	const waves = session ? await store.all('SELECT id,status,round,wave FROM workday_planning_waves WHERE session_id=? ORDER BY round,wave LIMIT 20', [session.id]) : [];
	const nodes = await store.all('SELECT kind,status,COUNT(*) AS count FROM execution_nodes WHERE workday_id=? AND team_id=? GROUP BY kind,status', [executionId, teamId]);
	const assignments = await store.all('SELECT status,COUNT(*) AS count FROM capacity_provider_assignments WHERE work_day_id=? AND team_id=? GROUP BY status', [executionId, teamId]);
	return { executionId, status: run.status, executionMode: run.execution_mode ?? null, sessionStatus: session?.status ?? null,
		waves: waves.map((wave: any) => ({ id: wave.id, status: wave.status, round: Number(wave.round), wave: Number(wave.wave) })),
		nodes: nodes.map((row: any) => ({ kind: row.kind, status: row.status, count: Number(row.count) })),
		assignments: assignments.map((row: any) => ({ status: row.status, count: Number(row.count) })) };
}
