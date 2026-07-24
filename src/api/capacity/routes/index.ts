import type { Hono } from 'hono';
import { installCapacityGovernanceRoutes } from './governance/policy/governance.ts';
import { installCapacityPolicyRoutes } from './support/policy.ts';
import { installCapacityRuntimeRoutes } from './runtime/runtime.ts';
import { installCapacityOperatorRoutes } from './support/operator.ts';
import { installProjectAgentOperatorRoutes, type ProjectAgentOperatorRouteOptions } from './projects/projects-core/project-agent-operator.ts';
import { installCapacityWorkdayRoutes } from './capacity/workdays/workdays.ts';
import { installCapacityPlanRoutes } from './capacity/planning/capacity-plans.ts';
import { installPlanningStateRoutes } from './support/planning-state.ts';
import { installStructuredEstimateRoutes } from './support/structured-estimates.ts';
import { installDecisionWorkGraphRoutes } from './treedx/graph/decision-work-graphs.ts';
import { installResearchWorkflowRoutes } from './operations/research-workflows.ts';
import { installProviderAssignmentRoutes } from './capacity/assignments/provider-assignments.ts';
import { installProviderWorkflowDispatchRoutes } from './capacity/providers/provider-workflow-dispatch.ts';
import { installProjectDiagnosticsRoutes, type ProjectDiagnosticsRouteOptions } from './projects/projects-core/project-diagnostics.ts';
import { installProjectAgentObservabilityRoutes, type ProjectAgentObservabilityRouteOptions } from './projects/projects-core/project-agent-observability.ts';
import { installTreeDxProxyRoutes, type TreeDxProxyRouteOptions } from './treedx/repositories/treedx-proxy.ts';
import { CapacityGovernanceError } from '../database.ts';

function installCapacityErrorBoundary(app: Hono) {
	app.onError((error, c) => {
		if (error instanceof CapacityGovernanceError) {
			return new Response(JSON.stringify({
				ok: false,
				error: error.message,
				code: error.code,
				details: error.details,
			}), { status: error.status, headers: { 'content-type': 'application/json' } });
		}
		if ('getResponse' in error && typeof error.getResponse === 'function') {
			const response = error.getResponse();
			return c.newResponse(response.body, response);
		}
		console.error(error);
		return c.text('Internal Server Error', 500);
	});
}

export function installCapacityRoutes(app: Hono, options: Parameters<typeof installCapacityGovernanceRoutes>[1] & ProjectAgentOperatorRouteOptions & ProjectDiagnosticsRouteOptions & ProjectAgentObservabilityRouteOptions & TreeDxProxyRouteOptions) {
	installCapacityErrorBoundary(app);
	installCapacityGovernanceRoutes(app, options);
	installCapacityPolicyRoutes(app, options);
	installCapacityRuntimeRoutes(app, options);
	installCapacityOperatorRoutes(app, options);
	installProjectAgentOperatorRoutes(app, options);
	installCapacityWorkdayRoutes(app, options);
	installCapacityPlanRoutes(app, options);
	installPlanningStateRoutes(app, options);
	installStructuredEstimateRoutes(app, options);
	installDecisionWorkGraphRoutes(app, options);
	installResearchWorkflowRoutes(app, options);
	installProviderAssignmentRoutes(app, options);
	installProviderWorkflowDispatchRoutes(app, options);
	installProjectDiagnosticsRoutes(app, options);
	installProjectAgentObservabilityRoutes(app, options);
	installTreeDxProxyRoutes(app, options);
}
