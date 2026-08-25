import type { ServerEvent, ServerEventBus } from '@modelcontextprotocol/server';
import type { SessionEvent, SessionEventService } from '../../realtime/session-events.ts';

type SessionEvents = Pick<SessionEventService, 'subscribe'>;

function mcpEvent(event: SessionEvent): ServerEvent | undefined {
	if (event.eventType.startsWith('discussion.')) return { kind: 'resource_updated', uri: 'treeseed://discussions' };
	if (event.eventType === 'capacity.assignment.available') return { kind: 'resource_updated', uri: `treeseed://assignments/${encodeURIComponent(event.resourceId)}` };
	if (event.eventType === 'resource.invalidated' && event.payload.resource === 'workday') {
		return { kind: 'resource_updated', uri: `treeseed://workdays/${encodeURIComponent(event.resourceId)}` };
	}
	return undefined;
}

export class SessionEventMcpBus implements ServerEventBus {
	private readonly listeners = new Set<(event: ServerEvent) => void>();
	private upstream: Array<() => void> = [];
	private starting: Promise<void> | undefined;

	constructor(
		private readonly sessionEvents: SessionEvents,
		private readonly teamIds: readonly string[],
		private readonly onerror: (error: Error) => void = () => undefined,
	) {}

	publish(event: ServerEvent) {
		for (const listener of this.listeners) {
			try { listener(event); } catch (error) { this.onerror(error instanceof Error ? error : new Error(String(error))); }
		}
	}

	subscribe(listener: (event: ServerEvent) => void) {
		this.listeners.add(listener);
		if (this.listeners.size === 1) this.start();
		let closed = false;
		return () => {
			if (closed) return;
			closed = true;
			this.listeners.delete(listener);
			if (this.listeners.size === 0) this.stop();
		};
	}

	private start() {
		if (this.starting || this.upstream.length > 0 || this.teamIds.length === 0) return;
		this.starting = Promise.all(this.teamIds.map((teamId) => this.sessionEvents.subscribe(teamId, (event) => {
			const mapped = mcpEvent(event);
			if (mapped) this.publish(mapped);
		}))).then((unsubscribers) => {
			if (this.listeners.size === 0) for (const unsubscribe of unsubscribers) unsubscribe();
			else this.upstream = unsubscribers;
		}).catch((error) => this.onerror(error instanceof Error ? error : new Error(String(error))))
			.finally(() => { this.starting = undefined; });
	}

	private stop() {
		for (const unsubscribe of this.upstream.splice(0)) unsubscribe();
	}
}
