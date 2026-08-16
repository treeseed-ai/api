import { listUnpublishedTreeDxAuthoringState } from '../../../treedx/repositories/treedx-authoring-journal.ts';
import { logicalModeRunSql } from '../../../../repositories/support/mode-run.ts';

type Row=Record<string,unknown>;
type Store={ first<T extends Row=Row>(sql:string,params?:unknown[]):Promise<T|null>; all(sql:string,params?:unknown[]):Promise<Row[]> };

function count(row:Row|null){ return Number(row?.count??0); }
function record(value:unknown):Row { return value&&typeof value==='object'&&!Array.isArray(value)?value as Row:{}; }
function records(value:unknown){ return Array.isArray(value)?value.map(record):[]; }
function activeCapabilityCount(assignment:Row) {
	const context=record(assignment.workspaceContext??assignment.workspace_context);
	const handles=record(assignment.capabilityHandles??context.capabilityHandles);
	return Object.values(handles).flatMap(records).filter((handle)=>String(handle.status??'')!=='revoked').length;
}
function sourceWorktreeCount(assignment:Row) {
	const output=record(assignment.lifecycleOutput??assignment.lifecycle_output);
	const manifest=record(output.artifactManifest??output.artifact_manifest);
	const roots=new Set<string>();
	const visit=(value:unknown):void=>{
		if(Array.isArray(value)){ value.forEach(visit); return; }
		const item=record(value);
		for(const [key,nested] of Object.entries(item)) {
			if(key==='worktreeRoot'&&typeof nested==='string'&&nested.trim()) roots.add(nested.trim());
			else if(nested&&typeof nested==='object') visit(nested);
		}
	};
	visit(manifest);
	return roots.size;
}

export async function observeAssignmentCleanup(store:Store,assignment:Row) {
	const assignmentId=String(assignment.id??''); const teamId=String(assignment.teamId??assignment.team_id??'');
	const projectId=String(assignment.projectId??assignment.project_id??''); const reservationId=String(assignment.reservationId??assignment.reservation_id??'');
	const status=String(assignment.status??''); const leaseState=String(assignment.leaseState??assignment.lease_state??'');
	const terminal=['completed','failed','cancelled','expired','returned'].includes(status);
	const [reservation,demand,workspace,modeRuns,unpublished]=await Promise.all([
		reservationId?store.first('SELECT COUNT(*) AS count FROM capacity_reservations WHERE id = ? AND team_id = ? AND state IN (\'reserved\',\'consuming\')',[reservationId,teamId]):null,
		store.first('SELECT COUNT(*) AS count FROM capacity_workday_demands WHERE assignment_id = ? AND team_id = ? AND status IN (\'pending\',\'claimed\',\'admitted\',\'blocked\')',[assignmentId,teamId]),
		store.first('SELECT COUNT(*) AS count FROM treedx_proxy_handles WHERE assignment_id = ? AND team_id = ? AND status = \'issued\'',[assignmentId,teamId]),
		store.first(`SELECT COUNT(*) AS count FROM agent_mode_runs WHERE provider_assignment_id = ? AND team_id = ? AND status IN ('queued','running') AND ${logicalModeRunSql()}`,[assignmentId,teamId]),
		listUnpublishedTreeDxAuthoringState(store,projectId,assignmentId),
	]);
	const cleanup={
		verified:false,activeAssignments:terminal?0:1,activeLeases:leaseState==='leased'?1:0,
		activeReservations:count(reservation),activeDemands:count(demand),activeWorkspaces:count(workspace),
		activeWorktrees:sourceWorktreeCount(assignment),unpublishedBranches:unpublished.length,
		staleAuthorities:count(modeRuns)+activeCapabilityCount(assignment),
	};
	cleanup.verified=Object.entries(cleanup).every(([key,value])=>key==='verified'||value===0);
	return { ...cleanup,assignmentId,projectId,observedAt:new Date().toISOString(),unpublished };
}
