import type { Hono } from 'hono';
import type { CapacityGovernanceDatabase } from '../database.ts';
import { commitCapacityAdmission } from '../services/admission-service.ts';
import { loadCapacityAdmissionState, type CapacityAdmissionStateRequest } from '../services/admission-state-service.ts';
import { compileAssignmentProjectContext } from '../services/assignment-context-service.ts';
import { readCapacityRequestObject } from './request-json.ts';
import { capacityRuntimeFailure, requireCapacityIdempotencyKey, type CapacityRuntimeRouteOptions } from './runtime-route-support.ts';

export function installAdmissionRuntimeRoutes(app: Hono, options: CapacityRuntimeRouteOptions) {
	app.post('/v1/teams/:teamId/capacity/admissions', async (c) => {
		try {
			const teamId = c.req.param('teamId');
			const access = await options.requireTeamAccess(c, options.store, teamId, 'teams:manage:team');
			if (access.response) return access.response;
			const body = await readCapacityRequestObject(c);
			const request: CapacityAdmissionStateRequest = {
				teamId, providerId: String(body.providerId ?? ''), membershipId: String(body.membershipId ?? ''), projectId: String(body.projectId ?? ''), environment: String(body.environment ?? ''), projectAgentClassId: String(body.projectAgentClassId ?? ''), mode: body.mode === 'acting' ? 'acting' : 'planning', workDayId: String(body.workDayId ?? ''), requestedCredits: Number(body.requestedCredits), executionProviderId: typeof body.executionProviderId === 'string' ? body.executionProviderId : null, laneId: typeof body.laneId === 'string' ? body.laneId : null, providerSessionId: typeof body.providerSessionId === 'string' ? body.providerSessionId : null, decisionId: typeof body.decisionId === 'string' ? body.decisionId : null, requiredCapabilities: Array.isArray(body.requiredCapabilities) ? body.requiredCapabilities.map(String) : [],
			};
			const admission = await loadCapacityAdmissionState(options.store, request);
			const project = await compileAssignmentProjectContext(options.store as CapacityGovernanceDatabase & Parameters<typeof compileAssignmentProjectContext>[0], request.projectId);
			const workspace = body.workspaceContext && typeof body.workspaceContext === 'object' && !Array.isArray(body.workspaceContext) ? body.workspaceContext as Record<string, unknown> : {};
			const result = await commitCapacityAdmission(options.store, {
				idempotencyKey: requireCapacityIdempotencyKey(c), admission,
				reservationId: typeof body.reservationId === 'string' ? body.reservationId : undefined,
				assignmentId: typeof body.assignmentId === 'string' ? body.assignmentId : undefined,
				assignment: { projectAgentClassId: request.projectAgentClassId, providerSessionId: request.providerSessionId, executionProviderId: request.executionProviderId, laneId: request.laneId, workDayId: request.workDayId, taskId: typeof body.taskId === 'string' ? body.taskId : null, agentId: typeof body.agentId === 'string' ? body.agentId : null, handlerId: typeof body.handlerId === 'string' ? body.handlerId : null, capacityEnvelope: body.capacityEnvelope && typeof body.capacityEnvelope === 'object' && !Array.isArray(body.capacityEnvelope) ? body.capacityEnvelope as Record<string, unknown> : {}, decisionInput: body.decisionInput && typeof body.decisionInput === 'object' && !Array.isArray(body.decisionInput) ? body.decisionInput as Record<string, unknown> : {}, workspaceContext: { ...workspace, project }, allowedOutputs: body.allowedOutputs && typeof body.allowedOutputs === 'object' && !Array.isArray(body.allowedOutputs) ? body.allowedOutputs as Record<string, unknown> : {}, metadata: { source: 'capacity_admission_api' } },
			});
			return c.json({ ok: true, payload: result }, { status: result.replayed ? 200 : 201 });
		} catch (error) { return capacityRuntimeFailure(c, error); }
	});
}
