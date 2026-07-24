import { createHash, randomUUID } from 'node:crypto';
import { NOTIFICATION_CONTENT_CAPABILITIES, normalizeNotificationPreferences } from '@treeseed/sdk/account-contracts';
import { sendAuthEmail } from '../auth/email.js';
import type { MarketControlPlaneStore } from '../api/persistence/store.js';

export interface ContentNotificationEventInput {
	idempotencyKey: string;
	eventType: string;
	contentType: string;
	projectId: string;
	actorId?: string | null;
	resourceId: string;
	title: string;
	summary?: string | null;
	targetUrl: string;
}

function deterministicId(prefix: string, value: string) {
	return `${prefix}-${createHash('sha256').update(value).digest('hex').slice(0, 32)}`;
}

function escapeHtml(value: unknown) {
	return String(value ?? '').replace(/[&<>"']/gu, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ?? character);
}

function notificationUrl(path: string) {
	const base = String(process.env.TREESEED_SITE_URL ?? process.env.TREESEED_BETTER_AUTH_URL ?? 'http://127.0.0.1:4321').replace(/\/+$/u, '');
	return `${base}${path}`;
}

function selectedContentTypes(preferences: ReturnType<typeof normalizeNotificationPreferences>, projectId: string) {
	return preferences.projectOverrides.find((entry) => entry.projectId === projectId)?.contentTypes ?? preferences.globalContentTypes;
}

function digestDueAt(cadence: 'immediate' | 'daily' | 'weekly', timeZone: string, now = new Date()) {
	if (cadence === 'immediate') return now.toISOString();
	const local = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
		timeZone, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit', hourCycle: 'h23', minute: '2-digit', second: '2-digit',
	}).formatToParts(now).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
	const localNow = new Date(Date.UTC(Number(local.year), Number(local.month) - 1, Number(local.day), Number(local.hour), Number(local.minute), Number(local.second)));
	const days = cadence === 'daily' ? (Number(local.hour) < 8 ? 0 : 1) : ((8 - localNow.getUTCDay()) % 7 || (Number(local.hour) < 8 ? 0 : 7));
	const desiredLocal = new Date(Date.UTC(Number(local.year), Number(local.month) - 1, Number(local.day) + days, 8, 0, 0));
	const probe = new Date(desiredLocal.getTime());
	const probeParts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23', minute: '2-digit', second: '2-digit' }).formatToParts(probe).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
	const renderedAsUtc = Date.UTC(Number(probeParts.year), Number(probeParts.month) - 1, Number(probeParts.day), Number(probeParts.hour), Number(probeParts.minute), Number(probeParts.second));
	return new Date(desiredLocal.getTime() - (renderedAsUtc - probe.getTime())).toISOString();
}

async function preferencesFor(store: MarketControlPlaneStore, userId: string) {
	const settings = await store.first<{ email_cadence: 'immediate' | 'daily' | 'weekly'; time_zone: string }>(`SELECT * FROM user_notification_preferences WHERE user_id = ? LIMIT 1`, [userId]);
	const globalRows = await store.all<{ content_type: string }>(`SELECT content_type FROM user_notification_global_content_types WHERE user_id = ?`, [userId]);
	const overrideRows = await store.all<{ project_id: string }>(`SELECT project_id FROM user_notification_project_overrides WHERE user_id = ?`, [userId]);
	const projectRows = await store.all<{ project_id: string; content_type: string }>(`SELECT project_id, content_type FROM user_notification_project_content_types WHERE user_id = ?`, [userId]);
	return normalizeNotificationPreferences({
		emailCadence: settings?.email_cadence,
		timeZone: settings?.time_zone,
		globalContentTypes: globalRows.map((row) => row.content_type),
		projectOverrides: overrideRows.map((row) => ({ projectId: row.project_id, contentTypes: projectRows.filter((type) => type.project_id === row.project_id).map((type) => type.content_type) })),
	});
}

export async function recordContentNotificationEvent(store: MarketControlPlaneStore, input: ContentNotificationEventInput) {
	const capability = NOTIFICATION_CONTENT_CAPABILITIES.find((entry) => entry.id === input.contentType && entry.eventTypes.includes(input.eventType));
	if (!capability) throw Object.assign(new Error('The content notification event is not registered.'), { status: 400, code: 'unregistered_notification_event' });
	if (!input.targetUrl.startsWith('/') || input.targetUrl.startsWith('//')) throw Object.assign(new Error('Notification target must be a safe application path.'), { status: 400 });
	const eventId = deterministicId('notification', input.idempotencyKey);
	if (await store.first(`SELECT id FROM notification_events WHERE id = ? LIMIT 1`, [eventId])) return { id: eventId, created: false, recipients: 0 };
	const project = await store.getProject(input.projectId);
	if (!project) throw Object.assign(new Error('Notification project was not found.'), { status: 404 });
	const now = new Date().toISOString();
	await store.run(`INSERT INTO notification_events (id, event_type, content_type, project_id, actor_id, resource_id, title, summary, target_url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [eventId, input.eventType, input.contentType, input.projectId, input.actorId ?? null, input.resourceId, input.title, input.summary ?? null, input.targetUrl, now]);
	let recipients = 0;
	for (const member of await store.listTeamMembers(project.teamId)) {
		if (member.status !== 'active' || member.userId === input.actorId) continue;
		const preferences = await preferencesFor(store, member.userId);
		if (!selectedContentTypes(preferences, input.projectId).includes(input.contentType)) continue;
		const notificationId = randomUUID();
		await store.run(`INSERT INTO user_notifications (id, user_id, event_id, read_at, created_at) VALUES (?, ?, ?, NULL, ?) ON CONFLICT (user_id, event_id) DO NOTHING`, [notificationId, member.userId, eventId, now]);
		const dueAt = digestDueAt(preferences.emailCadence, preferences.timeZone, new Date(now));
		const period = preferences.emailCadence === 'immediate' ? eventId : dueAt;
		const digestKey = deterministicId('delivery', `${member.userId}:${preferences.emailCadence}:${period}`);
		await store.run(`INSERT INTO notification_email_deliveries (id, user_id, event_id, digest_key, cadence, status, due_at, attempts, sent_at, last_error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, 0, NULL, NULL, ?, ?) ON CONFLICT (digest_key) DO NOTHING`, [randomUUID(), member.userId, preferences.emailCadence === 'immediate' ? eventId : null, digestKey, preferences.emailCadence, dueAt, now, now]);
		recipients += 1;
	}
	return { id: eventId, created: true, recipients };
}

export async function drainNotificationEmailOutbox(store: MarketControlPlaneStore, limit = 20) {
	const deliveries = await store.all<{
		id: string;
		user_id: string;
		event_id: string | null;
		due_at: string;
		cadence: 'immediate' | 'daily' | 'weekly';
	}>(`SELECT * FROM notification_email_deliveries WHERE status = 'pending' AND due_at <= ? ORDER BY due_at ASC LIMIT ?`, [new Date().toISOString(), limit]);
	let sent = 0;
	for (const delivery of deliveries) {
		const claimedAt = new Date().toISOString();
		await store.run(`UPDATE notification_email_deliveries SET status = 'sending', attempts = attempts + 1, updated_at = ? WHERE id = ? AND status = 'pending'`, [claimedAt, delivery.id]);
		try {
			const address = await store.first<{ email: string }>(`SELECT email FROM user_email_addresses WHERE user_id = ? AND status = 'verified' ORDER BY is_primary DESC, created_at ASC LIMIT 1`, [delivery.user_id]);
			if (!address?.email) throw new Error('No verified notification email is available.');
			const events = delivery.event_id
				? await store.all<{ title: string; summary: string | null; target_url: string }>(`SELECT notification_events.* FROM notification_events WHERE id = ?`, [delivery.event_id])
				: await store.all<{ title: string; summary: string | null; target_url: string }>(`SELECT notification_events.* FROM user_notifications INNER JOIN notification_events ON notification_events.id = user_notifications.event_id WHERE user_notifications.user_id = ? AND user_notifications.created_at <= ? AND user_notifications.created_at > ? ORDER BY user_notifications.created_at ASC`, [delivery.user_id, delivery.due_at, new Date(new Date(delivery.due_at).getTime() - (delivery.cadence === 'weekly' ? 7 : 1) * 86_400_000).toISOString()]);
			if (!events.length) throw new Error('No authorized notification events remain for delivery.');
			await sendAuthEmail(undefined, {
				to: address.email,
				subject: delivery.cadence === 'immediate' ? events[0].title : `TreeSeed ${delivery.cadence} notification digest`,
				text: events.map((event) => `${event.title}\n${event.summary ?? ''}\n${notificationUrl(event.target_url)}`).join('\n\n'),
				html: `<h1>${delivery.cadence === 'immediate' ? 'New TreeSeed notification' : 'TreeSeed notification digest'}</h1>${events.map((event) => `<h2>${escapeHtml(event.title)}</h2><p>${escapeHtml(event.summary)}</p><p><a href="${escapeHtml(notificationUrl(event.target_url))}">View in TreeSeed</a></p>`).join('')}`,
			});
			await store.run(`UPDATE notification_email_deliveries SET status = 'sent', sent_at = ?, updated_at = ? WHERE id = ?`, [new Date().toISOString(), new Date().toISOString(), delivery.id]);
			sent += 1;
		} catch (error) {
			await store.run(`UPDATE notification_email_deliveries SET status = CASE WHEN attempts >= 5 THEN 'failed' ELSE 'pending' END, due_at = ?, last_error = ?, updated_at = ? WHERE id = ?`, [new Date(Date.now() + 60_000).toISOString(), error instanceof Error ? error.message : String(error), new Date().toISOString(), delivery.id]);
		}
	}
	return { claimed: deliveries.length, sent };
}
