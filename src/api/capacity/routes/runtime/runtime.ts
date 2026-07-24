import type { Hono } from 'hono';
import { installAdmissionRuntimeRoutes } from './admission-runtime.ts';
import { installAvailabilityRuntimeRoutes } from './availability-runtime.ts';
import type { CapacityRuntimeRouteOptions } from './runtime-route-support.ts';
import { installUsageRuntimeRoutes } from '../capacity/accounting/usage-runtime.ts';

export function installCapacityRuntimeRoutes(app: Hono, options: CapacityRuntimeRouteOptions) {
	installAvailabilityRuntimeRoutes(app, options);
	installAdmissionRuntimeRoutes(app, options);
	installUsageRuntimeRoutes(app, options);
}
