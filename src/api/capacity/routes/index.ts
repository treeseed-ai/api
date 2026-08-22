import type { Hono } from 'hono';
import { CapacityGovernanceError } from '../database.ts';
import { installProviderAssignmentRoutes } from './capacity/assignments/provider-assignments.ts';
import { installCapacityGovernanceRoutes } from './governance/policy/governance.ts';
import { installResearchWorkflowRoutes } from './operations/research-workflows.ts';
import { installProjectDiagnosticsRoutes,type ProjectDiagnosticsRouteOptions } from './projects/projects-core/project-diagnostics.ts';
import { installCapacityRuntimeRoutes } from './runtime/runtime.ts';
import { installCapacityOperatorRoutes } from './support/operator.ts';
import { installPlanningStateRoutes } from './support/planning-state.ts';
import { installStructuredEstimateRoutes } from './support/structured-estimates.ts';
import { installDecisionWorkGraphRoutes } from './treedx/graph/decision-work-graphs.ts';
import { installTreeDxProxyRoutes,type TreeDxProxyRouteOptions } from './treedx/repositories/treedx-proxy.ts';

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

export function installCapacityRoutes(app: Hono, options: Parameters<typeof installCapacityGovernanceRoutes>[1] & ProjectDiagnosticsRouteOptions & TreeDxProxyRouteOptions & Parameters<typeof installProviderAssignmentRoutes>[1]) {
	installCapacityErrorBoundary(app);
	installCapacityGovernanceRoutes(app, options);
	installCapacityRuntimeRoutes(app, options);
	installCapacityOperatorRoutes(app, options);
	installPlanningStateRoutes(app, options);
	installStructuredEstimateRoutes(app, options);
	installDecisionWorkGraphRoutes(app, options);
	installResearchWorkflowRoutes(app, options);
	installProviderAssignmentRoutes(app, options);
	installProjectDiagnosticsRoutes(app, options);
	installTreeDxProxyRoutes(app, options);
}
