import type { Hono } from 'hono';
import { installCapacityGovernanceRoutes } from './governance.ts';
import { installCapacityPolicyRoutes } from './policy.ts';
import { installCapacityRuntimeRoutes } from './runtime.ts';
import { installCapacityOperatorRoutes } from './operator.ts';
import { installProjectAgentOperatorRoutes, type ProjectAgentOperatorRouteOptions } from './project-agent-operator.ts';
import { installCapacityWorkdayRoutes } from './workdays.ts';
import { installCapacityPlanRoutes } from './capacity-plans.ts';
import { installPlanningStateRoutes } from './planning-state.ts';
import { installStructuredEstimateRoutes } from './structured-estimates.ts';
import { installDecisionWorkGraphRoutes } from './decision-work-graphs.ts';
import { installResearchWorkflowRoutes } from './research-workflows.ts';
import { installProviderAssignmentRoutes } from './provider-assignments.ts';
import { installProviderWorkflowDispatchRoutes } from './provider-workflow-dispatch.ts';
import { installProjectDiagnosticsRoutes, type ProjectDiagnosticsRouteOptions } from './project-diagnostics.ts';
import { installProjectAgentObservabilityRoutes, type ProjectAgentObservabilityRouteOptions } from './project-agent-observability.ts';
import { installTreeDxProxyRoutes, type TreeDxProxyRouteOptions } from './treedx-proxy.ts';
import { CapacityGovernanceError } from '../database.ts';

function installCapacityErrorBoundary(app: Hono) {
	app.onError((error, c) => {
		if (error instanceof CapacityGovernanceError) {
			return c.json({
				ok: false,
				error: error.message,
				code: error.code,
				details: error.details,
			}, { status: error.status });
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
