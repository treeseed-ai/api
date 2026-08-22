import type { Hono } from 'hono';
import { CapacityGovernanceError } from '../database.ts';
import { installResearchWorkflowRoutes } from './operations/research-workflows.ts';
import { installCapacityOperatorRoutes } from './support/operator.ts';
import { installPlanningStateRoutes } from './support/planning-state.ts';
import { installStructuredEstimateRoutes } from './support/structured-estimates.ts';
import { installDecisionWorkGraphRoutes } from './treedx/graph/decision-work-graphs.ts';

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

export function installCapacityRoutes(app: Hono, options: { store: any; sessionEvents?: any; requireTeamAccess: (...args: any[]) => Promise<any>; requireProjectAccess: (...args: any[]) => Promise<any>; runtime: any; runtimeControlPlaneAuthProvider: any; config: Record<string, unknown> }) {
	installCapacityErrorBoundary(app);
	installCapacityOperatorRoutes(app, options);
	installPlanningStateRoutes(app, options);
	installStructuredEstimateRoutes(app, options);
	installDecisionWorkGraphRoutes(app, options);
	installResearchWorkflowRoutes(app, options);
}
