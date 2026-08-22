import { describe, expect, it } from 'vitest';
import type { SessionEvent } from '../../../../src/api/realtime/session-events.ts';
import { SessionEventMcpBus } from '../../../../src/api/control-plane/mcp/session-event-bus.ts';

describe('SessionEventMcpBus', () => {
	it('projects only authorized-team durable events and cleans up listeners', async () => {
		const listeners = new Map<string, Set<(event: SessionEvent) => void>>();
		const sessionEvents = { async subscribe(teamId: string, listener: (event: SessionEvent) => void) {
			const team = listeners.get(teamId) ?? new Set(); team.add(listener); listeners.set(teamId, team);
			return () => team.delete(listener);
		} };
		const bus = new SessionEventMcpBus(sessionEvents as never, ['team-a']);
		const received: unknown[] = [];
		const unsubscribe = bus.subscribe((event) => received.push(event));
		const second: unknown[] = [];
		const unsubscribeSecond = bus.subscribe((event) => second.push(event));
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(listeners.get('team-a')?.size).toBe(1);
		const event = (teamId: string, eventType: string, resourceId: string, payload: Record<string, unknown> = {}): SessionEvent => ({
			sequence: 1, teamId, eventType, resourceId, payload, projectId: null, createdAt: new Date(0).toISOString(),
		});
		for (const listener of listeners.get('team-a') ?? []) listener(event('team-a', 'discussion.updated', 'discussion-a'));
		for (const listener of listeners.get('team-b') ?? []) listener(event('team-b', 'discussion.updated', 'discussion-b'));
		for (const listener of listeners.get('team-a') ?? []) listener(event('team-a', 'capacity.assignment.available', 'assignment/a'));
		for (const listener of listeners.get('team-a') ?? []) listener(event('team-a', 'resource.invalidated', 'run-a', { resource: 'workday' }));
		expect(received).toEqual([
			{ kind: 'resource_updated', uri: 'treeseed://discussions' },
			{ kind: 'resource_updated', uri: 'treeseed://assignments/assignment%2Fa' },
			{ kind: 'resource_updated', uri: 'treeseed://workdays/run-a' },
		]);
		unsubscribe();
		expect(listeners.get('team-a')?.size).toBe(1);
		expect(second).toEqual(received);
		unsubscribeSecond();
		expect(listeners.get('team-a')?.size).toBe(0);
	});
});
