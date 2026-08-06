import { compileCooperativePlanningWaves, type AgentPlanningGraph } from '@treeseed/sdk/agent-capacity';
import { createHash } from 'node:crypto';
import type { CapacityGovernanceDatabase } from '../../../../database.ts';
import { CapacityGovernanceError } from '../../../../database.ts';

type Row = Record<string, unknown>;
type Snapshot = { revision: string; graph: AgentPlanningGraph; agents: Array<{ nodeId: string; slug: string; activityType: string; projectAgentClassId: string; execution: Row }> };

function integer(value: unknown, fallback: number) {
	const parsed = Number(value ?? fallback);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function digest(value: unknown) {
	return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export async function initializeCooperativePlanningSession(input: {
	database: CapacityGovernanceDatabase;
	teamId: string;
	runId: string;
	sessionId: string;
	snapshots: Map<string, Snapshot>;
	rounds: number;
	maxConcurrentAssignments: number;
	allocatedSeconds: number;
	assignmentTimeboxSeconds?: number;
	now: string;
}) {
	const graph: AgentPlanningGraph = { nodes: [], edges: [], externalRoots: [], diagnostics: [], ok: true };
	const participants: Array<{ agentId: string; nodeId: string; projectAgentClassId: string; timeboxSeconds: number }> = [];
	for (const [projectId, snapshot] of input.snapshots) {
		const qualify = (nodeId: string) => `${projectId}:${nodeId}`;
		graph.nodes.push(...snapshot.graph.nodes.map((node) => ({ ...node, id: qualify(node.id) })));
		graph.edges.push(...snapshot.graph.edges.map((edge) => ({ ...edge, fromNodeId: qualify(edge.fromNodeId), toNodeId: qualify(edge.toNodeId) })));
		graph.externalRoots.push(...snapshot.graph.externalRoots);
		for (const agent of snapshot.agents) participants.push({
			agentId: agent.slug,
			nodeId: qualify(agent.nodeId),
			projectAgentClassId: agent.projectAgentClassId,
			timeboxSeconds: Math.min(integer(agent.execution.timeboxSeconds ?? agent.execution.maxRuntimeSeconds, 900), integer(input.assignmentTimeboxSeconds, 900)),
		});
	}
	const compiled = compileCooperativePlanningWaves({ graph, participants, rounds: input.rounds, maxConcurrentAssignments: input.maxConcurrentAssignments, allocatedSeconds: input.allocatedSeconds });
	if (!compiled.fits) throw new CapacityGovernanceError('capacity_planning_session_time_insufficient', 'The cooperative planning profiles do not fit within the allocated agent time.', 409, { requiredSeconds: compiled.requiredSeconds, allocatedSeconds: input.allocatedSeconds });
	for (const participant of participants) await input.database.run(`INSERT INTO workday_planning_participants
		(id,session_id,agent_id,node_id,project_agent_class_id,status,metadata_json,created_at,updated_at) VALUES (?,?,?,?,?,'scheduled',?,?,?) ON CONFLICT(session_id,node_id) DO NOTHING`,
		[`participant:${input.sessionId}:${digest(participant.nodeId).slice(0, 16)}`, input.sessionId, participant.agentId, participant.nodeId, participant.projectAgentClassId, JSON.stringify({ timeboxSeconds: participant.timeboxSeconds }), input.now, input.now]);
	for (const wave of compiled.waves) await input.database.run(`INSERT INTO workday_planning_waves
		(id,session_id,round,wave,status,snapshot_ref,snapshot_json,assignment_ids_json,created_at,updated_at) VALUES (?,?,?,?,'scheduled','unresolved','{}','[]',?,?) ON CONFLICT(session_id,round,wave) DO NOTHING`,
		[`wave:${input.sessionId}:${wave.round}:${wave.wave}`, input.sessionId, wave.round, wave.wave, input.now, input.now]);
	await input.database.run(`UPDATE workday_planning_sessions SET metadata_json = ?, updated_at = ? WHERE id = ?`, [JSON.stringify({ participantNodes: participants.map((entry) => entry.nodeId), waves: compiled.waves, requiredSeconds: compiled.requiredSeconds }), input.now, input.sessionId]);
	return compiled;
}

function parsed(value: unknown): Row { try { const result = JSON.parse(String(value ?? '{}')); return result && typeof result === 'object' && !Array.isArray(result) ? result as Row : {}; } catch { return {}; } }
function strings(value: unknown) { return Array.isArray(value) ? value.map(String) : []; }

export async function currentCooperativePlanningWave(database: CapacityGovernanceDatabase, runId: string, now: string) {
	const session = await database.first(`SELECT * FROM workday_planning_sessions WHERE workday_run_id = ? AND status = 'running' LIMIT 1`, [runId]);
	if (!session) return null;
	let wave = await database.first(`SELECT * FROM workday_planning_waves WHERE session_id = ? AND status IN ('running','scheduled') ORDER BY round ASC,wave ASC LIMIT 1`, [session.id]);
	if (!wave) { await database.run(`UPDATE workday_planning_sessions SET status = 'completed',completed_at = ?,updated_at = ? WHERE id = ? AND status = 'running'`, [now, now, session.id]); return null; }
	if (wave.status === 'running') {
		const demands = await database.all(`SELECT project_id,status,metadata_json FROM capacity_workday_demands WHERE workday_run_id = ? AND metadata_json LIKE ?`, [runId, `%"planningWaveId":"${String(wave.id)}"%`]);
		const expectedNodes = waveNodes(session, wave);
		const instantiatedNodes = new Set(demands.map((demand) => `${String(demand.project_id)}:${String(parsed(demand.metadata_json).planningGraphNodeId ?? '')}`));
		const missingNodes = expectedNodes.filter((nodeId) => !instantiatedNodes.has(nodeId));
		const terminal = demands.filter((demand) => ['completed','failed','cancelled'].includes(String(demand.status))).length;
		const openedAt = Date.parse(String(wave.started_at ?? now));
		const compilationGraceOpen = demands.length === 0 && Number.isFinite(openedAt) && Date.parse(now) - openedAt < 30_000;
		if (!compilationGraceOpen && (demands.length === 0 || (terminal === demands.length && missingNodes.length))) {
			const failure = { code: 'planning_wave_no_eligible_assignments', waveId: wave.id, round: Number(wave.round), nodeIds: expectedNodes, missingNodeIds: missingNodes, observedAt: now };
			await database.run(`UPDATE workday_planning_waves SET status = 'failed',completed_at = ?,updated_at = ? WHERE id = ? AND status = 'running'`, [now, now, wave.id]);
			await database.run(`UPDATE workday_planning_sessions SET status = 'failed',metadata_json = ?,completed_at = ?,updated_at = ? WHERE id = ? AND status = 'running'`, [JSON.stringify({ ...parsed(session.metadata_json), failure }), now, now, session.id]);
			throw new CapacityGovernanceError('capacity_planning_wave_blocked', 'A cooperative planning wave could not instantiate an assignment from its required signals.', 409, failure);
		}
		if (demands.length > 0 && terminal === demands.length) {
			await database.run(`UPDATE workday_planning_waves SET status = 'completed',completed_at = ?,updated_at = ? WHERE id = ? AND status = 'running'`, [now, now, wave.id]);
			wave = await database.first(`SELECT * FROM workday_planning_waves WHERE session_id = ? AND status = 'scheduled' ORDER BY round ASC,wave ASC LIMIT 1`, [session.id]);
			if (!wave) { await database.run(`UPDATE workday_planning_sessions SET status = 'completed',completed_at = ?,updated_at = ? WHERE id = ?`, [now, now, session.id]); return null; }
		} else return { id: String(wave.id), round: Number(wave.round), nodeIds: waveNodes(session, wave), snapshotRef: String(wave.snapshot_ref), snapshot: parsed(wave.snapshot_json) };
	}
	const roundSnapshot = await database.first(`SELECT snapshot_ref,snapshot_json FROM workday_planning_waves WHERE session_id = ? AND round = ? AND snapshot_ref <> 'unresolved' ORDER BY wave ASC LIMIT 1`, [session.id, wave.round]);
	const snapshot = roundSnapshot?.snapshot_ref ? { ref: String(roundSnapshot.snapshot_ref), content: parsed(roundSnapshot.snapshot_json) } : await planningSnapshot(database, runId, Number(wave.round));
	await database.run(`UPDATE workday_planning_waves SET status = 'running',snapshot_ref = ?,snapshot_json = ?,started_at = ?,updated_at = ? WHERE id = ? AND status = 'scheduled'`, [snapshot.ref, JSON.stringify(snapshot.content), now, now, wave.id]);
	await database.run(`UPDATE workday_planning_sessions SET current_round = ?,updated_at = ? WHERE id = ?`, [wave.round, now, session.id]);
	return { id: String(wave.id), round: Number(wave.round), nodeIds: waveNodes(session, wave), snapshotRef: snapshot.ref, snapshot: snapshot.content };
}

function waveNodes(session: Row, wave: Row) {
	const metadata = parsed(session.metadata_json);
	const waves = Array.isArray(metadata.waves) ? metadata.waves.map((entry) => entry as Row) : [];
	return strings(waves.find((entry) => Number(entry.round) === Number(wave.round) && Number(entry.wave) === Number(wave.wave))?.participantNodeIds);
}

async function planningSnapshot(database: CapacityGovernanceDatabase, runId: string, round: number) {
	const [signals, proposals, modeRuns] = await Promise.all([
		database.all(`SELECT id,contract_id,subject_id,agent_id,activity_type,assignment_id,payload_json,digest,commit_sha,immutable_ref,evidence_ref,created_at FROM agent_signals WHERE workday_run_id = ? ORDER BY created_at,id`, [runId]),
		database.all(`SELECT id,title,summary,body,active_version,active_content_hash,status,proposal_type,proposal_types_json,metadata_json,updated_at FROM governance_proposals WHERE metadata_json LIKE ? ORDER BY id`, [`%"workdayRunId":"${runId}"%`]),
		database.all(`SELECT mode_run.id,mode_run.provider_assignment_id AS assignment_id,mode_run.agent_id,mode_run.mode,mode_run.handler_id,mode_run.status,mode_run.outputs_json,mode_run.trace_refs_json,mode_run.usage_actual_json,mode_run.completed_at
			FROM agent_mode_runs mode_run JOIN capacity_provider_assignments assignment ON assignment.id = mode_run.provider_assignment_id
			WHERE assignment.work_day_id = ? ORDER BY mode_run.created_at,mode_run.id`, [runId]).catch(() => []),
	]);
	const proposalIds=proposals.map((proposal)=>String(proposal.id));
	const discussions=proposalIds.length ? await database.all(`SELECT id,project_id,event_type,actor_type,actor_id,message,evidence_json,created_at FROM governance_events WHERE governance_type = 'proposal' AND governance_id IN (${proposalIds.map(()=>'?').join(',')}) ORDER BY created_at,id`,proposalIds).catch(()=>[]) : [];
	const content = { round, signals, proposals, discussions, modeRuns };
	return { ref: `planning-snapshot:${runId}:${round}:${digest(content)}`, content };
}
