import type { Hono } from 'hono';
import { installUsageRuntimeRoutes } from '../capacity/accounting/usage-runtime.ts';
import { installAdmissionRuntimeRoutes } from './admission-runtime.ts';
import type { CapacityRuntimeRouteOptions } from './runtime-route-support.ts';

export function installCapacityRuntimeRoutes(app: Hono, options: CapacityRuntimeRouteOptions) {
	installAdmissionRuntimeRoutes(app, options);
	installUsageRuntimeRoutes(app, options);
}
