import { createHash } from 'node:crypto';
import { createTestApp, describe, expect, it, json } from '../../../support/api-harness.ts';

function memoryStorage() {
	const objects = new Map<string, { bytes: Uint8Array; contentType: string }>();
	let sequence = 0;
	return {
		objects,
		async put(kind: string, bytes: Uint8Array, contentType: string) {
			const key = `${kind}/00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}.${contentType === 'image/png' ? 'png' : 'zip'}`;
			objects.set(key, { bytes, contentType });
			return { key, digest: createHash('sha256').update(bytes).digest('hex') };
		},
		async get(key: string) { return objects.get(key) ?? null; },
		async delete(key: string) { objects.delete(key); },
	};
}

async function actors(app: ReturnType<typeof createTestApp>) {
	const response = await json(await app.request('/v1/acceptance/seed', {
		method: 'POST',
		headers: { 'content-type': 'application/json', 'x-treeseed-service-id': 'web', 'x-treeseed-service-secret': 'web-test-secret' },
		body: JSON.stringify({ namespace: `feedback-${crypto.randomUUID()}`, actorsOnly: true, actors: {
			reporter: { userId: crypto.randomUUID(), email: `reporter-${crypto.randomUUID()}@example.test`, username: `reporter-${crypto.randomUUID().slice(0, 8)}`, siteRoles: ['member'] },
			admin: { userId: crypto.randomUUID(), email: `admin-${crypto.randomUUID()}@example.test`, username: `admin-${crypto.randomUUID().slice(0, 8)}`, siteRoles: ['platform_admin'] },
		} }),
	}));
	return { reporter: response.payload.actors.reporter.accessToken as string, admin: response.payload.actors.admin.accessToken as string };
}

const auth = (token: string, key?: string) => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(key ? { 'x-idempotency-key': key } : {}) });
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

describe('feedback management API', () => {
	it('persists authenticated context and a private redacted attachment without trusting spoofed identity', async () => {
		const storage = memoryStorage();
		const app = createTestApp({ feedbackStorage: storage });
		const actor = await actors(app);
		const digest = createHash('sha256').update(png).digest('hex');
		const idempotencyKey = `feedback-${crypto.randomUUID()}`;
		const body = { type: 'bug', message: 'The save control did not respond.', allowContact: true, userId: 'spoofed-user', contactEmail: 'spoofed@example.test', context: { canonicalPath: '/spoofed', teamId: 'unauthorized-team' }, client: { viewport: { width: 900, height: 700, devicePixelRatio: 1 } }, screenshot: { dataUrl: `data:image/png;base64,${png.toString('base64')}`, digest, redacted: true, redactionVersion: 'treeseed.feedback-capture/v3', maskedRegionCount: 2 } };
		const forbidden = await app.request('/v1/feedback', { method: 'POST', headers: auth(actor.reporter, idempotencyKey), body: JSON.stringify(body) });
		expect(forbidden.status).toBe(403);

		body.context = { canonicalPath: '/spoofed' } as any;
		const submitted = await app.request('/v1/feedback', { method: 'POST', headers: { ...auth(actor.reporter, idempotencyKey), 'x-treeseed-feedback-path': '/app/account?tab=password' }, body: JSON.stringify(body) });
		expect(submitted.status).toBe(201);
		const record = (await json(submitted)).payload;
		expect(storage.objects.size).toBe(1);
		const replay = await json(await app.request('/v1/feedback', { method: 'POST', headers: auth(actor.reporter, idempotencyKey), body: JSON.stringify(body) }));
		expect(replay.payload.id).toBe(record.id);

		expect((await app.request('/v1/admin/feedback', { headers: auth(actor.reporter) })).status).toBe(403);
		const detail = (await json(await app.request(`/v1/admin/feedback/${record.id}`, { headers: auth(actor.admin) }))).payload;
		expect(detail.canonicalPath).toBe('/app/account?tab=password');
		expect(detail.submitterId).not.toBe('spoofed-user');
		expect(detail.contactEmail).not.toBe('spoofed@example.test');
		expect(detail.attachments).toHaveLength(1);
		const image = await app.request(`/v1/admin/feedback/${record.id}/attachments/${detail.attachments[0].id}`, { headers: auth(actor.admin) });
		expect(image.headers.get('cache-control')).toBe('private, no-store');
		expect(Buffer.from(await image.arrayBuffer())).toEqual(png);
	});

	it('enforces optimistic ordered triage, resolution notes, and reopening notes', async () => {
		const app = createTestApp({ feedbackStorage: memoryStorage() });
		const actor = await actors(app);
		const submitted = await json(await app.request('/v1/feedback', { method: 'POST', headers: auth(actor.reporter, `feedback-${crypto.randomUUID()}`), body: JSON.stringify({ type: 'ux_issue', message: 'Navigation was difficult to understand.', allowContact: false, context: { canonicalPath: '/app/' }, client: { viewport: { width: 1200, height: 800, devicePixelRatio: 1 } } }) }));
		const id = submitted.payload.id;
		const change = (status: string, version: number, note?: string) => app.request(`/v1/admin/feedback/${id}/status`, { method: 'PATCH', headers: auth(actor.admin), body: JSON.stringify({ status, version, note }) });
		expect((await change('resolved', 1, 'Too early')).status).toBe(400);
		expect((await change('triaged', 1)).status).toBe(200);
		expect((await change('in_progress', 1)).status).toBe(409);
		expect((await change('in_progress', 2)).status).toBe(200);
		expect((await change('resolved', 3)).status).toBe(400);
		expect((await change('resolved', 3, 'Implemented and verified.')).status).toBe(200);
		expect((await change('in_progress', 4)).status).toBe(400);
		expect((await change('in_progress', 4, 'A regression needs follow-up.')).status).toBe(200);
		const detail = (await json(await app.request(`/v1/admin/feedback/${id}`, { headers: auth(actor.admin) }))).payload;
		expect(detail.status).toBe('in_progress');
		expect(detail.history.map((event: any) => event.toStatus)).toEqual(['triaged', 'in_progress', 'resolved', 'in_progress']);
	});
});
