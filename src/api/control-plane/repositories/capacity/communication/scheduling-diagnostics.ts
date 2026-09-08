import { selectWorkdayDemandSupply } from '../../../../capacity/repositories/capacity/workdays/workday-demand-supply.ts';

/** Metadata-only admission evidence; never include prompts, credentials or context bodies. */
export async function communicationSchedulingDiagnostics(store: any, teamId: string, executionId: string) {
	try { return await schedulingDiagnostics(store, teamId, executionId); }
	catch { return { executionId, status: 'unavailable', code: 'communication_scheduling_diagnostics_unavailable' }; }
}

async function schedulingDiagnostics(store: any, teamId: string, executionId: string) {
	if (!executionId) return null;
	const run = await store.first('SELECT id,status,parameters_json FROM capacity_workday_runs WHERE id=? AND team_id=?', [executionId, teamId]);
	if (!run) return null;
	const session = await store.first('SELECT id,status,metadata_json FROM workday_planning_sessions WHERE workday_run_id=? AND team_id=?', [executionId, teamId]);
	const waves = session ? await store.all('SELECT id,status,round,wave FROM workday_planning_waves WHERE session_id=? ORDER BY round,wave LIMIT 20', [session.id]) : [];
	const demands = await store.all('SELECT status,COUNT(*) AS count FROM capacity_workday_demands WHERE workday_run_id=? AND team_id=? GROUP BY status', [executionId, teamId]);
	const envelopes = await store.all('SELECT status,COUNT(*) AS count FROM workday_capacity_envelopes WHERE workday_run_id=? AND team_id=? GROUP BY status', [executionId, teamId]);
	const pending = await store.all(`SELECT demand.*,run.capacity_provider_id AS primary_provider_id FROM capacity_workday_demands demand
		JOIN capacity_workday_runs run ON run.id=demand.workday_run_id WHERE demand.workday_run_id=? AND demand.team_id=? AND demand.status='pending' LIMIT 5`, [executionId, teamId]);
	const supply = await Promise.all(pending.map(async (demand: any) => {
		const denials = await store.all("SELECT metadata_json,created_at FROM capacity_audit_events WHERE team_id=? AND resource_id=? AND action='assignment-function.denied' ORDER BY created_at DESC LIMIT 5", [teamId, demand.id]);
		const reasons = denials.flatMap((row: any) => { try { const metadata = typeof row.metadata_json === 'string' ? JSON.parse(row.metadata_json) : row.metadata_json; return Array.isArray(metadata?.reasons) ? metadata.reasons.filter((code: unknown) => typeof code === 'string' && /^[a-z][a-z0-9_]+$/.test(code)).map((code: string) => ({ code, at: row.created_at })) : []; } catch { return []; } });
		const selection = await selectWorkdayDemandSupply(store, demand, new Date().toISOString());
		return { demandId: demand.id, denials: reasons, selected: selection.selected ? { providerId: selection.selected.capacityProviderId, membershipId: selection.selected.membershipId, providerSessionId: selection.selected.providerSessionId, executionProviderId: selection.selected.executionProviderId } : null,
			eligibleCount: selection.eligible.length, rejected: selection.rejected.map((item) => ({ executionProviderId: item.candidate.executionProviderId, reasons: item.reasons })) };
	}));
	let parameters: any = {}; try { parameters = typeof run.parameters_json === 'string' ? JSON.parse(run.parameters_json) : run.parameters_json ?? {}; } catch { /* diagnostics must tolerate malformed metadata */ }
	return { executionId, status: run.status, executionMode: parameters.executionMode ?? null, sessionStatus: session?.status ?? null, supply,
		waves: waves.map((wave: any) => ({ id: wave.id, status: wave.status, round: Number(wave.round), wave: Number(wave.wave) })),
		demands: demands.map((row: any) => ({ status: row.status, count: Number(row.count) })),
		envelopes: envelopes.map((row: any) => ({ status: row.status, count: Number(row.count) })) };
}
