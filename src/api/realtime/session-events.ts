import type { Pool, PoolClient } from 'pg';

export interface SessionEvent {
	sequence: number;
	eventType: string;
	teamId: string;
	projectId: string | null;
	resourceId: string;
	payload: Record<string, unknown>;
	createdAt: string;
}

export interface SessionEventStore {
	all<T extends Record<string, unknown>>(query: string, params?: unknown[]): Promise<T[]>;
	first<T extends Record<string, unknown>>(query: string, params?: unknown[]): Promise<T | null>;
	run(query: string, params?: unknown[]): Promise<unknown>;
}

type Listener = (event: SessionEvent) => void;
const channel = 'treeseed_session_events';

function deserialize(row: Record<string, unknown>): SessionEvent {
	let payload: Record<string, unknown> = {};
	try { payload = JSON.parse(String(row.payload_json ?? '{}')); } catch { /* Invalid payloads remain empty envelopes. */ }
	return {
		sequence: Number(row.sequence), eventType: String(row.event_type), teamId: String(row.team_id),
		projectId: row.project_id ? String(row.project_id) : null, resourceId: String(row.resource_id),
		payload, createdAt: String(row.created_at),
	};
}

export async function persistSessionEvent(store: SessionEventStore, input: { eventType: string; teamId: string; projectId?: string | null; resourceId: string; payload?: Record<string, unknown> }) {
	if (/token[._-]?delta|delta[._-]?token/iu.test(input.eventType)) throw new Error('Transient token deltas cannot be persisted as durable session events.');
	const now = new Date();
	const row = await store.first<Record<string, unknown>>(
		`INSERT INTO session_events (event_type, team_id, project_id, resource_id, payload_json, created_at, expires_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`,
		[input.eventType, input.teamId, input.projectId ?? null, input.resourceId, JSON.stringify(input.payload ?? {}), now.toISOString(), new Date(now.getTime() + 7 * 86_400_000).toISOString()],
	);
	if (!row) throw new Error('The session event was not persisted.');
	const event = deserialize(row);
	await store.first(`SELECT pg_notify(?, ?)`, [channel, String(event.sequence)]).catch(() => null);
	if (event.sequence % 100 === 0) void store.run(`DELETE FROM session_events WHERE expires_at < ?`, [now.toISOString()]).catch(() => undefined);
	return event;
}

export class SessionEventService {
	private readonly listeners = new Map<string, Set<Listener>>();
	private listenerClient: PoolClient | null = null;
	private listenerPromise: Promise<void> | null = null;
	private listenerCleanup: (() => void) | null = null;
	private closingListener: Promise<void> | null = null;
	private readonly recent = new Set<number>();

	constructor(private readonly store: SessionEventStore, private readonly pool?: Pool) {}

	async publish(input: { eventType: string; teamId: string; projectId?: string | null; resourceId: string; payload?: Record<string, unknown> }) {
		const event = await persistSessionEvent(this.store, input);
		this.emit(event);
		return event;
	}

	async list(teamId: string, after: number, limit = 200) {
		const rows = await this.store.all<Record<string, unknown>>(
			`SELECT * FROM session_events WHERE team_id = ? AND sequence > ? AND expires_at >= ? ORDER BY sequence ASC LIMIT ?`,
			[teamId, Math.max(0, after), new Date().toISOString(), Math.min(500, Math.max(1, limit))],
		);
		return rows.map(deserialize);
	}

	async subscribe(teamId: string, listener: Listener) {
		let teamListeners = this.listeners.get(teamId);
		if (!teamListeners) { teamListeners = new Set(); this.listeners.set(teamId, teamListeners); }
		const registration: Listener = event => listener(event);
		teamListeners.add(registration);
		let released = false;
		const release = () => {
			if (released) return;
			released = true;
			teamListeners.delete(registration);
			if (!teamListeners.size && this.listeners.get(teamId) === teamListeners) this.listeners.delete(teamId);
			if (!this.listeners.size) this.closeDatabaseListener();
		};
		try { await this.ensureDatabaseListener(); } catch (error) { release(); throw error; }
		return release;
	}

	private emit(event: SessionEvent) {
		if (this.recent.has(event.sequence)) return;
		this.recent.add(event.sequence);
		if (this.recent.size > 1_000) this.recent.delete(this.recent.values().next().value!);
		for (const listener of this.listeners.get(event.teamId) ?? []) listener(event);
	}

	private async ensureDatabaseListener() {
		if (this.closingListener) await this.closingListener;
		if (!this.pool || this.listenerClient) return;
		if (!this.listenerPromise) {
			const opening = this.openDatabaseListener();
			this.listenerPromise = opening;
			void opening.then(() => { if (this.listenerPromise === opening) this.listenerPromise = null; },
				() => { if (this.listenerPromise === opening) this.listenerPromise = null; });
		}
		await this.listenerPromise;
	}

	private async openDatabaseListener() {
		const client = await this.pool!.connect();
		// A native connection error also rejects the activation query. Handle the
		// emitter during activation without replacing that original rejection.
		const activatingError = () => undefined;
		client.on('error', activatingError);
		try {
			await client.query(`LISTEN ${channel}`);
		} catch (error) { client.release(true); throw error; }
		finally { client.removeListener('error', activatingError); }
		const onNotification = (notice: { channel: string; payload?: string }) => {
			if (this.listenerClient !== client || notice.channel !== channel) return;
				const sequence = Number(notice.payload);
				if (!Number.isSafeInteger(sequence) || sequence <= 0 || this.recent.has(sequence)) return;
				void this.store.first<Record<string, unknown>>(`SELECT * FROM session_events WHERE sequence = ? LIMIT 1`, [sequence])
					.then((row) => { if (row && this.listenerClient === client) this.emit(deserialize(row)); })
					.catch(error => this.reportListenerFailure(error));
		};
		const cleanup = () => { client.removeListener('notification', onNotification); client.removeListener('error', onError); };
		const onError = () => {
			if (this.listenerClient !== client) return;
			this.listenerClient = null; this.listenerCleanup = null; cleanup();
			// This failed client is discarded, never returned for another generation.
			client.on('error', () => undefined); client.release(true);
			if (this.listeners.size) void this.ensureDatabaseListener().catch(error => this.reportListenerFailure(error));
		};
		client.on('notification', onNotification); client.on('error', onError);
		this.listenerClient = client; this.listenerCleanup = cleanup;
	}

	private closeDatabaseListener() {
		const client = this.listenerClient, cleanup = this.listenerCleanup;
		if (!client) return;
		this.listenerClient = null; this.listenerCleanup = null;
		const closing = client.query(`UNLISTEN ${channel}`).then(() => { cleanup?.(); client.release(); }, error => {
			cleanup?.(); client.on('error', () => undefined); client.release(true); this.reportListenerFailure(error);
		});
		this.closingListener = closing;
		void closing.then(() => { if (this.closingListener === closing) this.closingListener = null; });
	}

	private reportListenerFailure(error: unknown) {
		console.error('Session event listener failed.', error);
	}
}
