import type { Hono } from 'hono';
import { CapacityGovernanceError } from '../database.ts';
import { AvailabilitySessionService } from '../services/availability-session-service.ts';
import { requireProviderPrincipal } from './provider-auth.ts';
import { readCapacityRequestObject } from './request-json.ts';
import { capacityRuntimeFailure, type CapacityRuntimeRouteOptions } from './runtime-route-support.ts';

export function installAvailabilityRuntimeRoutes(app: Hono, options: CapacityRuntimeRouteOptions) {
	const availability = new AvailabilitySessionService(options.store);
	app.post('/v1/provider/availability-sessions', async (c) => {
		try {
			const principal = requireProviderPrincipal(c, ['provider:availability:write']);
			const session = await availability.open(principal, await readCapacityRequestObject(c, { optional: true }));
			return c.json({ ok: true, payload: session }, { status: 201 });
		} catch (error) { return capacityRuntimeFailure(c, error); }
	});
	app.put('/v1/provider/availability-sessions/:sessionId', async (c) => {
		try {
			const principal = requireProviderPrincipal(c, ['provider:availability:write']);
			const session = await availability.refresh(principal, c.req.param('sessionId'), await readCapacityRequestObject(c, { optional: true }));
			if (!session) throw new CapacityGovernanceError('provider_availability_refresh_conflict', 'Availability session refresh was rejected because the session is closed, expired, or changed concurrently.', 409);
			return c.json({ ok: true, payload: session });
		} catch (error) { return capacityRuntimeFailure(c, error); }
	});
	app.post('/v1/provider/availability-sessions/:sessionId/close', async (c) => {
		try {
			const principal = requireProviderPrincipal(c, ['provider:availability:write']);
			const session = await availability.close(principal, c.req.param('sessionId'));
			if (!session) throw new CapacityGovernanceError('provider_availability_not_found', 'Availability session does not exist for this membership.', 404);
			return c.json({ ok: true, payload: session });
		} catch (error) { return capacityRuntimeFailure(c, error); }
	});
}
