import { type AgentPlanningGraph } from '@treeseed/sdk/agent-capacity';
import { expandSignalDependencyClosure } from '../../../../policy/workdays/cooperative-planning.ts';
import { createHash } from 'node:crypto';
import type { CapacityDatabaseOperation,CapacityGovernanceDatabase } from '../../../../database.ts';
import { CapacityGovernanceError } from '../../../../database.ts';
import type { WorkdayPlanningGraphSnapshot } from '../policy/workday-planning-graph-policy.ts';

type Row = Record<string, unknown>;
type Participant = { agentId: string; nodeId: string; projectAgentClassId: string; timeboxSeconds: number };
type Request = { sessionId: string; targetKind: string; targetId: string; rationale: string; closure: string[]; missing: Participant[]; targetRound: number | null; projectedSeconds: number };

function record(value: unknown): Row { return value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {}; }
function text(value: unknown) { return typeof value === 'string' ? value.trim() : ''; }
function parsed(value: unknown): Row { try { return record(JSON.parse(String(value ?? '{}'))); } catch { return {}; } }
function strings(value: unknown) { return Array.isArray(value) ? value.map(String) : []; }
function hash(value: string) { return createHash('sha256').update(value).digest('hex').slice(0,16); }
function boundedTimebox(value: unknown) { const number = Number(value); return Number.isInteger(number) && number > 0 ? Math.min(number,86_400) : 900; }

function dependencyClosure(graph: AgentPlanningGraph, targets: string[]) {
	if (!graph.ok || graph.diagnostics.some((entry) => entry.code.includes('cycle'))) throw new CapacityGovernanceError('planning_participant_graph_invalid', 'The frozen planning graph cannot safely expand participants.', 409);
	return expandSignalDependencyClosure(graph,targets);
}

export async function validatePlanningParticipantRequest(input: { database: CapacityGovernanceDatabase; assignment: Row; snapshot: WorkdayPlanningGraphSnapshot; payload: Row }): Promise<Request> {
	const targetKind = text(input.payload.targetKind); const targetId = text(input.payload.targetId); const rationale = text(input.payload.rationale);
	if (!['agent','class'].includes(targetKind) || !targetId || !rationale) throw new CapacityGovernanceError('planning_participant_request_invalid', 'Participant requests require targetKind, targetId, and rationale.', 422);
	const targets = input.snapshot.agents.filter((agent) => targetKind === 'agent' ? agent.slug === targetId : [agent.projectAgentClassId,agent.projectAgentClassSlug].includes(targetId)).map((agent) => agent.nodeId);
	if (!targets.length) throw new CapacityGovernanceError('planning_participant_target_not_frozen', 'Requested participant is outside this immutable workday graph.', 409,{ targetKind,targetId });
	const projectId = text(input.assignment.projectId); const closure = dependencyClosure(input.snapshot.graph,targets).map((nodeId) => `${projectId}:${nodeId}`);
	const session = await input.database.first(`SELECT * FROM workday_planning_sessions WHERE workday_run_id = ? AND status = 'running' LIMIT 1`,[record(input.assignment.metadata).workdayRunId]);
	if (!session) throw new CapacityGovernanceError('planning_participant_session_inactive', 'Participant requests require an active cooperative planning session.',409);
	if (Date.parse(String(session.deadline)) <= Date.now()) throw new CapacityGovernanceError('planning_participant_deadline_elapsed','The planning session deadline has elapsed.',409);
	const scheduled = new Set((await input.database.all(`SELECT node_id FROM workday_planning_participants WHERE session_id = ?`,[session.id])).map((row) => text(row.node_id)));
	const missingNodeIds = closure.filter((nodeId) => !scheduled.has(nodeId));
	const missing = missingNodeIds.map((qualified) => {
		const nodeId = qualified.slice(projectId.length + 1); const agent = input.snapshot.agents.find((entry) => entry.nodeId === nodeId);
		if (!agent) throw new CapacityGovernanceError('planning_participant_node_invalid','A requested dependency has no frozen agent profile.',409,{ nodeId });
		return { agentId:agent.slug,nodeId:qualified,projectAgentClassId:agent.projectAgentClassId,timeboxSeconds:boundedTimebox(record(agent.execution).timeboxSeconds ?? record(agent.execution).maxRuntimeSeconds) };
	});
	const nextWave = missing.length ? await input.database.first(`SELECT round FROM workday_planning_waves WHERE session_id = ? AND status = 'scheduled' AND round > ? ORDER BY round,wave LIMIT 1`,[session.id,session.current_round]) : null;
	if (missing.length && !nextWave) throw new CapacityGovernanceError('planning_participant_round_unavailable','No unstarted planning round remains for the requested dependency closure.',409,{ missingNodeIds });
	const metadata = parsed(session.metadata_json); const addedSeconds = missing.reduce((sum,entry) => sum + entry.timeboxSeconds,0); const projectedSeconds = Number(metadata.requiredSeconds ?? session.reserved_seconds ?? 0) + addedSeconds;
	if (projectedSeconds > Number(session.allocated_seconds)) throw new CapacityGovernanceError('planning_participant_time_insufficient','The requested participant closure does not fit in remaining cooperative-planning time.',409,{ requiredSeconds:projectedSeconds,allocatedSeconds:Number(session.allocated_seconds),missingNodeIds });
	return { sessionId:String(session.id),targetKind,targetId,rationale,closure,missing,targetRound:nextWave ? Number(nextWave.round) : null,projectedSeconds };
}

function rebuiltRoundWaves(metadata: Row,request: Request,maxConcurrent: number,timeboxes: Map<string,number>) {
	const waves = Array.isArray(metadata.waves) ? metadata.waves.map(record) : []; if (!request.targetRound) return waves;
	const prior = waves.filter((wave) => Number(wave.round) !== request.targetRound); const current = waves.filter((wave) => Number(wave.round) === request.targetRound);
	const nodes = [...new Set([...current.flatMap((wave) => strings(wave.participantNodeIds)),...request.missing.map((entry) => entry.nodeId)])].sort();
	const rebuilt: Row[] = []; for (let cursor=0;cursor<nodes.length;cursor+=maxConcurrent) { const participantNodeIds=nodes.slice(cursor,cursor+maxConcurrent); rebuilt.push({ round:request.targetRound,wave:rebuilt.length+1,stage:'deliberation',participantNodeIds,requestedSeconds:participantNodeIds.reduce((sum,nodeId)=>sum+(timeboxes.get(nodeId) ?? 900),0) }); }
	return [...prior,...rebuilt].sort((left,right) => Number(left.round)-Number(right.round) || Number(left.wave)-Number(right.wave));
}

export async function recordPlanningParticipantRequest(database: CapacityGovernanceDatabase,request: Request,signalId: string,now: string) {
	const session = await database.first(`SELECT * FROM workday_planning_sessions WHERE id = ? AND status = 'running' LIMIT 1`,[request.sessionId]);
	if (!session) throw new CapacityGovernanceError('planning_participant_session_changed','The planning session changed before the request could be recorded.',409);
	const participantRows=await database.all(`SELECT node_id,metadata_json FROM workday_planning_participants WHERE session_id = ?`,[request.sessionId]);
	const timeboxes=new Map(participantRows.map((row)=>[text(row.node_id),boundedTimebox(parsed(row.metadata_json).timeboxSeconds)])); for(const entry of request.missing) timeboxes.set(entry.nodeId,entry.timeboxSeconds);
	const metadata = parsed(session.metadata_json); const maxConcurrent = Math.max(1,Number(metadata.maxActiveAssignments ?? 1)); const waves = rebuiltRoundWaves(metadata,request,maxConcurrent,timeboxes);
	const operations: CapacityDatabaseOperation[] = [];
	for (const participant of request.missing) operations.push({ query:`INSERT INTO workday_planning_participants (id,session_id,agent_id,node_id,project_agent_class_id,status,requested_by_signal_id,rationale,metadata_json,created_at,updated_at) VALUES (?,?,?,?,?,'scheduled',?,?,?, ?, ?) ON CONFLICT(session_id,node_id) DO NOTHING`,params:[`participant:${request.sessionId}:${hash(participant.nodeId)}`,request.sessionId,participant.agentId,participant.nodeId,participant.projectAgentClassId,signalId,request.rationale,JSON.stringify({ timeboxSeconds:participant.timeboxSeconds,participationRequests:[{ signalId,targetKind:request.targetKind,targetId:request.targetId,rationale:request.rationale }] }),now,now] });
	if (request.targetRound) {
		operations.push({ query:`DELETE FROM workday_planning_waves WHERE session_id = ? AND round = ? AND status = 'scheduled'`,params:[request.sessionId,request.targetRound] });
		for (const wave of waves.filter((entry) => Number(entry.round) === request.targetRound)) operations.push({ query:`INSERT INTO workday_planning_waves (id,session_id,round,wave,status,snapshot_ref,snapshot_json,assignment_ids_json,created_at,updated_at) VALUES (?,?,?,?,'scheduled','unresolved','{}','[]',?,?)`,params:[`wave:${request.sessionId}:${wave.round}:${wave.wave}`,request.sessionId,wave.round,wave.wave,now,now] });
	}
	operations.push({ query:`UPDATE workday_planning_sessions SET metadata_json = ?,updated_at = ? WHERE id = ? AND status = 'running'`,params:[JSON.stringify({ ...metadata,participantNodes:[...new Set([...strings(metadata.participantNodes),...request.missing.map((entry) => entry.nodeId)])],waves,requiredSeconds:request.projectedSeconds }),now,request.sessionId] });
	await database.batch(operations);
}
