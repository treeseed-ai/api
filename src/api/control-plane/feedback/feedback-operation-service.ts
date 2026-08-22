import { randomUUID } from 'node:crypto';
import { isFeedbackStatus, isFeedbackType, type FeedbackCollectionFilters } from '@treeseed/sdk/feedback';
import type { OperationInvocationContext } from '../catalog/operation-registry.ts';
import { principalHasPlatformPermission } from '../../security/permissions.ts';
import { createPrivateObjectStorage } from '../../storage/private-object-storage.ts';
import { changeFeedbackStatus, existingIdempotentFeedback, feedbackDetail, feedbackRateAllowed, jsonValue, listFeedback, primaryVerifiedEmail } from '../../feedback/repository.ts';
import { derivedCanonicalPath, parseFeedbackBody, parseScreenshot } from '../../feedback/validation.ts';
import { FeedbackOperationError } from './feedback-operation-error.ts';

type Principal = NonNullable<OperationInvocationContext['principal']>;
const requirePrincipal = (principal: OperationInvocationContext['principal']) => {
	if (!principal) throw new FeedbackOperationError(401, 'authentication_required', 'Sign in to send product feedback.');
	return principal;
};
const requireAdmin = (principal: OperationInvocationContext['principal']) => {
	const value = requirePrincipal(principal);
	if (!principalHasPlatformPermission(value, 'feedback:read:global')) throw new FeedbackOperationError(403, 'feedback_admin_forbidden', 'Platform administrator access is required.');
	return value;
};
const filters = (value: Record<string, unknown>): FeedbackCollectionFilters => ({
	query: typeof value.query === 'string' ? value.query.slice(0, 200) : undefined,
	status: isFeedbackStatus(value.status) ? value.status : undefined,
	type: isFeedbackType(value.type) ? value.type : undefined,
	teamId: typeof value.teamId === 'string' ? value.teamId.slice(0, 160) : undefined,
	hasScreenshot: value.hasScreenshot === true || value.hasScreenshot === 'true' ? true : value.hasScreenshot === false || value.hasScreenshot === 'false' ? false : undefined,
	from: typeof value.from === 'string' ? value.from : undefined, to: typeof value.to === 'string' ? value.to : undefined,
	cursor: typeof value.cursor === 'string' ? value.cursor : undefined, limit: Number(value.limit) || undefined,
});
const summary = (row: any) => ({ id: row.id, type: row.type, status: row.status, message: row.message, submitterId: row.submitter_user_id, submitterLabel: row.submitter_label ?? undefined, teamId: row.team_id ?? undefined, teamLabel: row.team_label ?? undefined, projectId: row.project_id ?? undefined, canonicalPath: row.canonical_path, hasScreenshot: Boolean(row.has_screenshot), createdAt: row.created_at, updatedAt: row.updated_at, resolvedAt: row.resolved_at ?? undefined, version: Number(row.version) });

export function createFeedbackOperationService(store: any, options: any = {}) {
	return {
		async create(principalValue: OperationInvocationContext['principal'], bodyValue: Record<string, unknown>, idempotencyKey?: string, requestUrl = 'http://localhost/v1/feedback', requestHeaders: Readonly<Record<string, string>> = {}) {
			const principal = requirePrincipal(principalValue);
			if (!idempotencyKey) throw new FeedbackOperationError(400, 'idempotency_key_required', 'A valid submission identifier is required.');
			const existing = await existingIdempotentFeedback(store, principal.id, idempotencyKey);
			if (existing) return { id: existing.id, status: existing.status, replayed: true };
			if (!await feedbackRateAllowed(store, principal.id)) throw new FeedbackOperationError(429, 'feedback_rate_limited', 'Too many feedback submissions were received recently.');
			const parsed = parseFeedbackBody(bodyValue); if ('error' in parsed) throw new FeedbackOperationError(400, 'feedback_invalid', parsed.error);
			const input = parsed.value;
			input.context.canonicalPath = derivedCanonicalPath(new Request(requestUrl, { headers: requestHeaders }), input.context.canonicalPath);
			input.context.environment = process.env.TREESEED_ENVIRONMENT?.trim() || (process.env.NODE_ENV === 'production' ? 'production' : 'local');
			input.context.buildId = process.env.TREESEED_BUILD_ID ?? process.env.TREESEED_SOURCE_CLOSURE ?? undefined;
			input.context.revision = process.env.TREESEED_SOURCE_CLOSURE ?? undefined;
			if (input.context.projectId) {
				const project = await store.getProject(input.context.projectId); if (!project) throw new FeedbackOperationError(404, 'context_not_found', 'The attached project context no longer exists.');
				if (!await store.resolvePrincipalTeamContext(project.teamId, principal)) throw new FeedbackOperationError(403, 'context_forbidden', 'The project context is not visible to this principal.');
				input.context.teamId = project.teamId;
			} else if (input.context.teamId && !await store.resolvePrincipalTeamContext(input.context.teamId, principal)) throw new FeedbackOperationError(403, 'context_forbidden', 'The team context is not visible to this principal.');
			const screenshot = parseScreenshot(input.screenshot); if ('error' in screenshot) throw new FeedbackOperationError(400, 'screenshot_invalid', screenshot.error);
			const id = randomUUID(); const attachmentId = screenshot.value ? randomUUID() : null; const now = new Date().toISOString();
			const contactEmail = input.allowContact ? await primaryVerifiedEmail(store, principal.id) : null;
			const storage = createPrivateObjectStorage({ adapter: options.feedbackStorage }); let stored: { key: string; digest: string } | null = null;
			try {
				if (screenshot.value) stored = await storage.put('feedback-attachments', screenshot.value.bytes, 'image/png');
				await store.run(`INSERT INTO feedback_submissions (id, type, status, message, submitter_user_id, team_id, project_id, canonical_path, route_pattern, capability_id, environment, build_id, revision, context_json, client_json, allow_contact, contact_email, idempotency_key, version, resolved_at, created_at, updated_at) VALUES (?, ?, 'new', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, ?, ?)`, [id, input.type, input.message, principal.id, input.context.teamId ?? null, input.context.projectId ?? null, input.context.canonicalPath, input.context.routePattern ?? null, input.context.capabilityId ?? null, input.context.environment ?? null, input.context.buildId ?? null, input.context.revision ?? null, JSON.stringify(input.context), JSON.stringify(input.client), input.allowContact ? 1 : 0, contactEmail, idempotencyKey, now, now]);
				if (screenshot.value && stored && attachmentId) await store.run('INSERT INTO feedback_attachments (id, feedback_id, storage_key, mime_type, byte_size, width, height, digest, redaction_version, masked_region_count, expires_at, expired_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)', [attachmentId, id, stored.key, 'image/png', screenshot.value.bytes.length, screenshot.value.width, screenshot.value.height, stored.digest, screenshot.value.redactionVersion, screenshot.value.maskedRegionCount, now]);
				await store.recordAuditEvent({ eventType: 'feedback.submitted', actorType: 'user', actorId: principal.id, targetType: 'feedback', targetId: id, data: { feedbackId: id, type: input.type, teamId: input.context.teamId ?? null, projectId: input.context.projectId ?? null, hasScreenshot: Boolean(stored) } });
			} catch (error) {
				if (stored) await storage.delete(stored.key).catch(() => undefined);
				await store.run('DELETE FROM feedback_attachments WHERE feedback_id = ?', [id]).catch(() => undefined); await store.run('DELETE FROM feedback_submissions WHERE id = ?', [id]).catch(() => undefined);
				const duplicate = await existingIdempotentFeedback(store, principal.id, idempotencyKey); if (duplicate) return { id: duplicate.id, status: duplicate.status, replayed: true };
				throw error;
			}
			return { id, status: 'new', hasScreenshot: Boolean(stored) };
		},
		async list(principalValue: OperationInvocationContext['principal'], query: Record<string, unknown>) {
			requireAdmin(principalValue); const result = await listFeedback(store, filters(query));
			return { items: result.rows.map(summary), nextCursor: result.nextCursor, teams: result.teams, counts: result.counts };
		},
		async show(principalValue: OperationInvocationContext['principal'], id: string) {
			requireAdmin(principalValue); const result = await feedbackDetail(store, id); if (!result) throw new FeedbackOperationError(404, 'feedback_not_found', 'Feedback was not found.');
			const row = result.feedback; const [submitter, team] = await Promise.all([store.first('SELECT id, username, display_name, metadata_json FROM users WHERE id = ?', [row.submitter_user_id]), row.team_id ? store.first('SELECT id, slug, name, display_name FROM teams WHERE id = ?', [row.team_id]) : null]);
			const metadata = jsonValue<Record<string, unknown>>(submitter?.metadata_json, {});
			return { ...summary(row), submitter: submitter ? { id: submitter.id, username: submitter.username ?? undefined, displayName: submitter.display_name ?? submitter.username ?? 'User', image: typeof metadata.image === 'string' ? metadata.image : undefined } : undefined, team: team ? { id: team.id, slug: team.slug, displayName: team.display_name ?? team.name } : undefined, allowContact: Boolean(row.allow_contact), contactEmail: row.contact_email ?? undefined, context: jsonValue(row.context_json, {}), client: jsonValue(row.client_json, {}), attachments: result.attachments.map((item: any) => ({ id: item.id, mimeType: item.mime_type, byteSize: Number(item.byte_size), digest: item.digest, createdAt: item.created_at, expiresAt: item.expires_at, expiredAt: item.expired_at })), history: result.history };
		},
		async updateStatus(principalValue: OperationInvocationContext['principal'], id: string, body: Record<string, unknown>, ifMatch?: string) {
			const principal = requireAdmin(principalValue); if (!isFeedbackStatus(body.status)) throw new FeedbackOperationError(400, 'status_invalid', 'Choose a valid feedback status.');
			const version = Number(ifMatch); if (!Number.isInteger(version) || version < 1) throw new FeedbackOperationError(400, 'feedback_version_invalid', 'If-Match must contain the current numeric feedback version.');
			const result = await changeFeedbackStatus(store, { id, actorId: principal.id, status: body.status, note: typeof body.note === 'string' ? body.note.slice(0, 4000) : undefined, version });
			if (result.code === 'not_found') throw new FeedbackOperationError(404, result.code, 'Feedback was not found.');
			if (result.code === 'conflict') throw new FeedbackOperationError(409, result.code, 'Feedback changed since it was read.');
			if (result.code === 'invalid_transition' || result.code === 'note_required') throw new FeedbackOperationError(400, result.code, result.code === 'note_required' ? 'A transition note is required.' : 'The requested status transition is invalid.');
			await store.recordAuditEvent({ eventType: body.status === 'resolved' ? 'feedback.resolved' : result.previousStatus === 'resolved' ? 'feedback.reopened' : 'feedback.status_changed', actorType: 'user', actorId: principal.id, targetType: 'feedback', targetId: id, data: { fromStatus: result.previousStatus, toStatus: body.status, version: result.version } });
			return { id, status: body.status, version: result.version };
		},
	};
}
