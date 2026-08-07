import type { SessionEvent, SessionEventService } from '../../realtime/session-events.ts';

function sse(event: SessionEvent) {
	return `id: ${event.sequence}\nevent: ${event.eventType}\ndata: ${JSON.stringify(event)}\n\n`;
}

export function installSessionEventRoutes(context: any) {
	const { app, jsonError, requireTeamAccess, sessionEvents, store } = context as { app: any; jsonError: any; requireTeamAccess: any; sessionEvents: SessionEventService; store: any };
	app.get('/v1/session/events', async (c: any) => {
		const teamId = String(c.req.query('teamId') ?? '').trim();
		if (!teamId) return jsonError(c, 400, 'A team is required for the session event stream.');
		const access = await requireTeamAccess(c, store, teamId, 'projects:read:team');
		if (access.response) return access.response;
		let after = Math.max(0, Number(c.req.header('Last-Event-ID') ?? c.req.query('after') ?? 0) || 0);
		const encoder = new TextEncoder();
		let unsubscribe = () => undefined;
		let heartbeat: ReturnType<typeof setInterval> | undefined;
		const stream = new ReadableStream<Uint8Array>({
			async start(controller) {
				let replaying = true;
				const buffered: SessionEvent[] = [];
				const send = (event: SessionEvent) => {
					if (replaying) { buffered.push(event); return; }
					if (event.sequence <= after) return;
					after = event.sequence;
					controller.enqueue(encoder.encode(sse(event)));
				};
				unsubscribe = await sessionEvents.subscribe(teamId, send);
				const replay: SessionEvent[] = [];
				for (let page = 0; page < 10; page += 1) {
					const events = await sessionEvents.list(teamId, replay.at(-1)?.sequence ?? after, 500);
					replay.push(...events);
					if (events.length < 500) break;
				}
				replaying = false;
				for (const event of [...replay, ...buffered].sort((left, right) => left.sequence - right.sequence)) send(event);
				controller.enqueue(encoder.encode(`event: session.ready\ndata: ${JSON.stringify({ teamId, cursor: after })}\n\n`));
				heartbeat = setInterval(() => controller.enqueue(encoder.encode(`: heartbeat ${Date.now()}\n\n`)), 15_000);
				c.req.raw.signal.addEventListener('abort', () => { unsubscribe(); if (heartbeat) clearInterval(heartbeat); try { controller.close(); } catch { /* Already cancelled. */ } }, { once: true });
			},
			cancel() { unsubscribe(); if (heartbeat) clearInterval(heartbeat); },
		});
		return new Response(stream, { headers: {
			'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive',
			'x-accel-buffering': 'no', 'x-content-type-options': 'nosniff',
		} });
	});
}
