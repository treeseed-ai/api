import assert from 'node:assert/strict';
import { CONTROL_PLANE_OPERATIONS } from '@treeseed/sdk/operator-contracts';
import type { ProviderAssignmentStore } from '../../../../../../../../src/api/control-plane/repositories/providers/provider-assignment-support.ts';
import { createProviderAssignmentService } from '../../../../../../../../src/api/control-plane/repositories/providers/provider-assignment-service.ts';
import { dependencyRevocation } from '../credentials/dependency-revocation-fixture.ts';

// Unit callbacks observe prohibited work, not native authorization or SQL.
export function longpollGuard(prohibitWork = false, subscriptionReady?: Promise<void>) {
	let reads = 0, writes = 0, leases = 0, subscriptions = 0;
	let releases = 0, listener: ((event: { eventType: string; payload: Record<string, unknown> }) => void) | undefined;
	const inputs: Record<string, unknown>[] = [];
	const unexpectedWrite = async () => { writes++; throw new Error('Unexpected unit longpoll write'); };
	const store: ProviderAssignmentStore = { ensureInitialized: async () => undefined,
		first: async () => { reads++; if (prohibitWork) throw new Error('Unexpected unit longpoll read'); return null; },
		all: async () => { reads++; if (prohibitWork) throw new Error('Unexpected unit longpoll read'); return []; },
		run: unexpectedWrite, batch: unexpectedWrite,
		leaseNextProviderAssignment: async (_principal, body) => { leases++; inputs.push(structuredClone(body)); if (prohibitWork) throw new Error('Unexpected unit longpoll lease'); return { assignment: null, leaseToken: null, leaseSeconds: 30 }; },
		getProviderAssignment: async () => null, renewProviderAssignmentLease: async () => null,
		returnProviderAssignment: async () => null, completeProviderAssignment: async () => null, failProviderAssignment: async () => null };
	const service = createProviderAssignmentService(store, { subscribe: async (_teamId, callback) => { subscriptions++; listener = callback; await subscriptionReady; return () => { releases++; listener = undefined; }; } });
	const auth = { principal: { teamId: 'team', membershipId: 'membership', capacityProviderId: 'provider', scopes: ['provider:assignments:read'] } };
	return { service, auth, counts: () => ({ reads, writes, leases, subscriptions }), inputs: () => structuredClone(inputs),
		releases: () => releases, wake: () => listener?.({ eventType: 'capacity.assignment.available', payload: { lanePurpose: 'workday' } }) };
}

export async function beforeOriginalDeadline<T>(promise: Promise<T>, deadline: string): Promise<T> {
	const remaining = Date.parse(deadline) - Date.now(); assert.ok(remaining > 0, 'Original longpoll authority exhausted');
	let timer: ReturnType<typeof setTimeout> | undefined;
	try { return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => reject(new Error('Original longpoll authority exhausted')), remaining);
	})]); } finally { if (timer) clearTimeout(timer); }
}

export async function dependencyLongpoll(subscriptionReady?: Promise<void>) {
	const f = await dependencyRevocation(subscriptionReady);
	try {
		assert.equal((await f.evaluate()).eligible, true);
		let polls = 0, completedPolls = 0;
		const original = f.store.leaseNextProviderAssignment.bind(f.store);
		let lastResult: Awaited<ReturnType<typeof original>> | undefined;
		const pollInputs: Record<string, unknown>[] = [];
		// Narrow delegated observation ONLY. Original SQL/synthesis/recovery/CAS and
		// serializer still determine every result; no alternative leasing operation.
		f.store.leaseNextProviderAssignment = async (principal, body) => {
			polls++; pollInputs.push(structuredClone(body)); try { lastResult = await original(principal, body); return lastResult; } finally { completedPolls++; }
		};
		const remaining = Date.parse(f.attempt.deadline) - Date.now(); assert.ok(remaining > 0);
		// The actual existing workday claim is deliberately outside the requested
		// lane. This request INPUT does not mutate the canonical pending Attempt.
		const body = { ...f.requestBody, laneId: 'foreign-lane', waitSeconds: remaining / 2000 };
		const controller = new AbortController();
		let pending: Promise<Response> | undefined;
		let owningPending: ReturnType<typeof f.service.next> | undefined;
		const start = (requestBody: Record<string, unknown> = body) => { assert.equal(pending, undefined); pending = f.request(requestBody, { token: f.token, signal: controller.signal }); return pending; };
		// SAME original service and genuinely authenticated principal. This bypasses
		// HTTP serialization deliberately: the owning boundary receives this exact
		// mutable caller object, not a JSON copy or a replacement poll operation.
		const startOwning = (requestBody: Record<string, unknown> = body) => {
			assert.equal(pending, undefined); assert.equal(owningPending, undefined);
			owningPending = f.service.next(f.authenticated, requestBody, controller.signal);
			// Observe rejection immediately while the test awaits its SQL/event
			// barriers. Keep the ORIGINAL rejecting promise for result and cleanup.
			void owningPending.catch(() => undefined); return owningPending;
		};
		const decode = async (response: Response) => {
			const value: unknown = await response.json(); assert.ok(value && typeof value === 'object' && 'data' in value);
			return CONTROL_PLANE_OPERATIONS.providers.nextAssignment.schema.output.parse(value.data);
		};
		const waitForPollAfter = async (count: number) => {
			while (completedPolls <= count) {
				assert.ok(Date.now() < Date.parse(f.attempt.deadline) && !controller.signal.aborted, 'Original longpoll observation authority exhausted');
				await new Promise<void>(resolve => setTimeout(resolve, 1));
			}
		};
		const publish = (teamId = f.principal.teamId, lanePurpose = 'workday') => f.events.publish({ teamId,
			eventType: 'capacity.assignment.available', resourceId: f.attempt.id, payload: { lanePurpose } });
		return { ...f, body, controller, start, startOwning, decode, publish, waitForPollAfter, polls: () => polls, lastPoll: () => lastResult,
			pollInputs: () => structuredClone(pollInputs),
			async close() { controller.abort(); try { if (pending) await pending; if (owningPending) await owningPending; } finally { await f.close(); } } };
	} catch (error) { await f.close(); throw error; }
}
