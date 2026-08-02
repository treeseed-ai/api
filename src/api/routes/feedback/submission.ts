import { randomUUID } from 'node:crypto';
import { createPrivateObjectStorage } from '../../storage/private-object-storage.ts';
import { existingIdempotentFeedback, feedbackRateAllowed, primaryVerifiedEmail } from '../../feedback/repository.ts';
import { derivedCanonicalPath, parseFeedbackBody, parseScreenshot } from '../../feedback/validation.ts';

function error(c: any, status: number, code: string, message: string, field?: string) {
	return c.json({ ok: false, code, message, fieldErrors: field ? { [field]: message } : undefined }, { status });
}

function validIdempotencyKey(value: string) {
	return /^[A-Za-z0-9_-]{16,120}$/u.test(value);
}

function serverEnvironment() {
	const configured = process.env.TREESEED_ENVIRONMENT?.trim();
	if (configured === 'staging' || configured === 'production' || configured === 'local') return configured;
	return process.env.NODE_ENV === 'production' ? 'production' : 'local';
}

export function installFeedbackSubmissionRoutes({ app, store, options }: any) {
	app.post('/v1/feedback', async (c: any) => {
		c.header('cache-control', 'private, no-store');
		const principal = c.get('principal');
		if (!principal || c.get('actorType') === 'service') return error(c, 401, 'authentication_required', 'Sign in to send product feedback.');
		const idempotencyKey = c.req.header('idempotency-key') || c.req.header('x-idempotency-key') || '';
		if (!validIdempotencyKey(idempotencyKey)) return error(c, 400, 'idempotency_required', 'A valid submission identifier is required.');
		const existing = await existingIdempotentFeedback(store, principal.id, idempotencyKey);
		if (existing) return c.json({ ok: true, code: 'feedback_already_submitted', message: 'Feedback already received.', payload: { id: existing.id, status: existing.status } }, { status: 200 });
		if (!await feedbackRateAllowed(store, principal.id)) return error(c, 429, 'feedback_rate_limited', 'You have sent several reports recently. Please try again later.');
		const parsed = parseFeedbackBody(await c.req.json().catch(() => ({})));
		if ('error' in parsed) return error(c, 400, 'feedback_invalid', parsed.error, parsed.field);
		const input = parsed.value;
		input.context.canonicalPath = derivedCanonicalPath(c.req.raw, input.context.canonicalPath);
		input.context.environment = serverEnvironment();
		input.context.buildId = process.env.TREESEED_BUILD_ID ?? process.env.TREESEED_SOURCE_CLOSURE ?? undefined;
		input.context.revision = process.env.TREESEED_SOURCE_CLOSURE ?? undefined;
		if (input.context.projectId) {
			const project = await store.getProject(input.context.projectId);
			if (!project) return error(c, 404, 'context_not_found', 'The attached project context no longer exists.');
			if (!await store.resolvePrincipalTeamContext(project.teamId, principal)) return error(c, 403, 'context_forbidden', 'You cannot attach that project context.');
			input.context.teamId = project.teamId;
		} else if (input.context.teamId && !await store.resolvePrincipalTeamContext(input.context.teamId, principal)) {
			return error(c, 403, 'context_forbidden', 'You cannot attach that team context.');
		}
		const screenshot = parseScreenshot(input.screenshot);
		if ('error' in screenshot) return error(c, 400, 'screenshot_invalid', screenshot.error, 'screenshot');
		const id = randomUUID();
		const attachmentId = screenshot.value ? randomUUID() : null;
		const now = new Date().toISOString();
		const contactEmail = input.allowContact ? await primaryVerifiedEmail(store, principal.id) : null;
		const storage = createPrivateObjectStorage({ adapter: options?.feedbackStorage });
		let stored: { key: string; digest: string } | null = null;
		try {
			if (screenshot.value) stored = await storage.put('feedback-attachments', screenshot.value.bytes, 'image/png');
			await store.run(`INSERT INTO feedback_submissions (id, type, status, message, submitter_user_id, team_id, project_id, canonical_path, route_pattern, capability_id, environment, build_id, revision, context_json, client_json, allow_contact, contact_email, idempotency_key, version, resolved_at, created_at, updated_at) VALUES (?, ?, 'new', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, ?, ?)`, [id, input.type, input.message, principal.id, input.context.teamId ?? null, input.context.projectId ?? null, input.context.canonicalPath, input.context.routePattern ?? null, input.context.capabilityId ?? null, input.context.environment ?? null, input.context.buildId ?? null, input.context.revision ?? null, JSON.stringify(input.context), JSON.stringify(input.client), input.allowContact ? 1 : 0, contactEmail, idempotencyKey, now, now]);
			if (screenshot.value && stored && attachmentId) {
				await store.run('INSERT INTO feedback_attachments (id, feedback_id, storage_key, mime_type, byte_size, width, height, digest, redaction_version, masked_region_count, expires_at, expired_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)', [attachmentId, id, stored.key, 'image/png', screenshot.value.bytes.length, screenshot.value.width, screenshot.value.height, stored.digest, screenshot.value.redactionVersion, screenshot.value.maskedRegionCount, now]);
			}
			await store.recordAuditEvent({ eventType: 'feedback.submitted', actorType: 'user', actorId: principal.id, targetType: 'feedback', targetId: id, data: { feedbackId: id, type: input.type, teamId: input.context.teamId ?? null, projectId: input.context.projectId ?? null, hasScreenshot: Boolean(stored) } });
		} catch (caught) {
			if (stored) await storage.delete(stored.key).catch(() => undefined);
			await store.run('DELETE FROM feedback_attachments WHERE feedback_id = ?', [id]).catch(() => undefined);
			await store.run('DELETE FROM feedback_submissions WHERE id = ?', [id]).catch(() => undefined);
			const duplicate = await existingIdempotentFeedback(store, principal.id, idempotencyKey);
			if (duplicate) return c.json({ ok: true, code: 'feedback_already_submitted', message: 'Feedback already received.', payload: { id: duplicate.id, status: duplicate.status } }, { status: 200 });
			throw caught;
		}
		return c.json({ ok: true, code: 'feedback_submitted', message: `Feedback sent. Reference ${id.slice(0, 8)}.`, payload: { id, status: 'new', hasScreenshot: Boolean(stored) }, reset: true }, { status: 201 });
	});
}
