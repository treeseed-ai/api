import { randomUUID } from 'node:crypto';
import { CONTROL_PLANE_OPERATIONS } from '@treeseed/sdk/operator-contracts';
import { isValidPersonalThemeDraft, normalizeNotificationPreferences } from '@treeseed/sdk/account-contracts';
import { normalizeUsername, validateUsername } from '../../../../auth/profile-validation.ts';
import { ControlPlaneOperationError, type BoundOperation } from '../operation-registry.ts';
import type { AccountOperationDependencies } from '../account-operations.ts';
import { affected, claimAccountRevision, requireRevision } from './concurrency.ts';

function actor(context: { principal?: Record<string, any> }) {
	if (!context.principal) throw new ControlPlaneOperationError(401, 'authentication_required', 'Authentication is required.');
	return context.principal;
}

function theme(row: Record<string, any>) {
	return { id: row.id, schemeId: `personal-${row.id}`, name: row.name, baseScheme: row.base_scheme,
		palette: JSON.parse(row.palette_json), compilerVersion: Number(row.compiler_version), createdAt: row.created_at, updatedAt: row.updated_at };
}

export function createAccountAdminOperations(dependencies: AccountOperationDependencies): BoundOperation[] {
	const operations = CONTROL_PLANE_OPERATIONS.accounts;
	return [
		{ binding: operations.updateUsername, async handler(input, context) {
			const principal = actor(context), username = normalizeUsername(String((input.body as any).username ?? ''));
			await claimAccountRevision(dependencies.store, principal.id, context.ifMatch);
			const validation = validateUsername(username);
			if (!validation.ok) throw new ControlPlaneOperationError(400, 'invalid_username', validation.message);
			if (await dependencies.store.first('SELECT id FROM users WHERE LOWER(username) = LOWER(?) AND id <> ? LIMIT 1', [username, principal.id])
				|| await dependencies.store.teamPublicNameExists(username))
				throw new ControlPlaneOperationError(409, 'username_taken', 'That username is unavailable.');
			const now = new Date().toISOString();
			await dependencies.store.batch!([
				{ query: 'UPDATE users SET username = ?, updated_at = ? WHERE id = ?', params: [username, now, principal.id] },
				{ query: 'UPDATE control_plane_auth_credentials SET username = ?, updated_at = ? WHERE user_id = ?', params: [username, now, principal.id] },
			]);
			return { changed: true, username };
		} },
		{ binding: operations.notificationPreferences, async handler(_input, context) {
			const principal = actor(context);
			const [preference, globalTypes, overrides] = await Promise.all([
				dependencies.store.first('SELECT email_cadence, updated_at FROM user_notification_preferences WHERE user_id = ?', [principal.id]),
				dependencies.store.all('SELECT content_type FROM user_notification_global_content_types WHERE user_id = ? ORDER BY content_type', [principal.id]),
				dependencies.store.all('SELECT project_id, content_type FROM user_notification_project_content_types WHERE user_id = ? ORDER BY project_id, content_type', [principal.id]),
			]);
			const grouped = new Map<string, string[]>();
			for (const row of overrides) grouped.set(row.project_id, [...(grouped.get(row.project_id) ?? []), row.content_type]);
			return { ...normalizeNotificationPreferences({ emailCadence: preference?.email_cadence, globalContentTypes: globalTypes.map((row) => row.content_type), projectOverrides: [...grouped].map(([projectId, contentTypes]) => ({ projectId, contentTypes })) } as any), updatedAt: String(preference?.updated_at ?? '0') };
		} },
		{ binding: operations.updateNotificationPreferences, async handler(input, context) {
			const principal = actor(context), preferences = normalizeNotificationPreferences(input.body as any), now = new Date().toISOString();
			const existing = await dependencies.store.first('SELECT updated_at FROM user_notification_preferences WHERE user_id = ?', [principal.id]);
			requireRevision(existing?.updated_at, context.ifMatch, 'notification_preferences');
			const allowedProjects = new Set((await dependencies.store.listProjectsForPrincipal(principal)).map((project) => project.id));
			if (preferences.projectOverrides.some((override) => !allowedProjects.has(override.projectId)))
				throw new ControlPlaneOperationError(403, 'notification_project_forbidden', 'Notification overrides may reference only accessible projects.');
			const claim = existing
				? await dependencies.store.run('UPDATE user_notification_preferences SET email_cadence = ?, updated_at = ? WHERE user_id = ? AND updated_at = ?', [preferences.emailCadence, now, principal.id, context.ifMatch])
				: await dependencies.store.run('INSERT INTO user_notification_preferences (user_id, email_cadence, created_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (user_id) DO NOTHING', [principal.id, preferences.emailCadence, now, now]);
			if (affected(claim) !== 1) throw new ControlPlaneOperationError(412, 'notification_preferences_precondition_failed', 'The notification preferences changed after they were inspected.');
			const statements: Array<{ query: string; params?: unknown[] }> = [
				{ query: 'DELETE FROM user_notification_global_content_types WHERE user_id = ?', params: [principal.id] },
				{ query: 'DELETE FROM user_notification_project_content_types WHERE user_id = ?', params: [principal.id] },
			];
			for (const contentType of preferences.globalContentTypes) statements.push({ query: 'INSERT INTO user_notification_global_content_types (user_id, content_type) VALUES (?, ?)', params: [principal.id, contentType] });
			for (const override of preferences.projectOverrides) for (const contentType of override.contentTypes) statements.push({ query: 'INSERT INTO user_notification_project_content_types (user_id, project_id, content_type) VALUES (?, ?, ?)', params: [principal.id, override.projectId, contentType] });
			await dependencies.store.batch!(statements);
			return { ...preferences, updatedAt: now };
		} },
		{ binding: operations.themes, async handler(_input, context) {
			return { items: (await dependencies.store.all('SELECT * FROM user_personal_themes WHERE user_id = ? ORDER BY updated_at DESC', [actor(context).id])).map(theme) };
		} },
		{ binding: operations.createTheme, async handler(input, context) {
			const principal = actor(context), draft = input.body;
			if (!isValidPersonalThemeDraft(draft)) throw new ControlPlaneOperationError(400, 'invalid_theme', 'Provide a valid personal theme.');
			const id = randomUUID(), now = new Date().toISOString();
			await dependencies.store.run('INSERT INTO user_personal_themes (id, user_id, name, normalized_name, base_scheme, palette_json, compiler_version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)', [id, principal.id, draft.name.trim(), draft.name.trim().toLowerCase(), draft.baseScheme, JSON.stringify(draft.palette), now, now]);
			return { id, schemeId: `personal-${id}`, ...draft, compilerVersion: 1, createdAt: now, updatedAt: now };
		} },
		{ binding: operations.updateTheme, async handler(input, context) {
			const principal = actor(context), draft = input.body;
			if (!isValidPersonalThemeDraft(draft)) throw new ControlPlaneOperationError(400, 'invalid_theme', 'Provide a valid personal theme.');
			const now = new Date().toISOString(), existing = await dependencies.store.first('SELECT * FROM user_personal_themes WHERE id = ? AND user_id = ?', [input.path.themeId, principal.id]);
			if (!existing) throw new ControlPlaneOperationError(404, 'theme_missing', 'The personal theme was not found.');
			requireRevision(existing.updated_at, context.ifMatch, 'personal_theme');
			const result = await dependencies.store.run('UPDATE user_personal_themes SET name = ?, normalized_name = ?, base_scheme = ?, palette_json = ?, updated_at = ? WHERE id = ? AND user_id = ? AND updated_at = ?', [draft.name.trim(), draft.name.trim().toLowerCase(), draft.baseScheme, JSON.stringify(draft.palette), now, input.path.themeId, principal.id, context.ifMatch]);
			if (affected(result) !== 1) throw new ControlPlaneOperationError(412, 'personal_theme_precondition_failed', 'The personal theme changed after it was inspected.');
			return theme({ ...existing, name: draft.name.trim(), base_scheme: draft.baseScheme, palette_json: JSON.stringify(draft.palette), updated_at: now });
		} },
		{ binding: operations.deleteTheme, async handler(input, context) {
			const principal = actor(context);
			const existing = await dependencies.store.first('SELECT updated_at FROM user_personal_themes WHERE id = ? AND user_id = ?', [input.path.themeId, principal.id]);
			if (!existing) throw new ControlPlaneOperationError(404, 'theme_missing', 'The personal theme was not found.');
			requireRevision(existing.updated_at, context.ifMatch, 'personal_theme');
			const result = await dependencies.store.run('DELETE FROM user_personal_themes WHERE id = ? AND user_id = ? AND updated_at = ?', [input.path.themeId, principal.id, context.ifMatch]);
			if (affected(result) !== 1) throw new ControlPlaneOperationError(412, 'personal_theme_precondition_failed', 'The personal theme changed after it was inspected.');
			return { deleted: true, id: input.path.themeId };
		} },
		{ binding: operations.unlinkProvider, async handler(input, context) {
			const principal = actor(context), identity = await dependencies.store.first("SELECT id FROM user_identities WHERE id = ? AND user_id = ? AND provider <> 'credential'", [input.path.identityId, principal.id]);
			if (!identity) throw new ControlPlaneOperationError(404, 'identity_missing', 'The linked provider was not found.');
			const methods = await dependencies.store.first("SELECT (SELECT COUNT(*) FROM user_identities WHERE user_id = ? AND provider <> 'credential') + (SELECT COUNT(*) FROM control_plane_auth_credentials WHERE user_id = ? AND status = 'active') AS count", [principal.id, principal.id]);
			if (Number(methods?.count ?? 0) <= 1) throw new ControlPlaneOperationError(409, 'last_authentication_method', 'Add another sign-in method before unlinking this provider.');
			await dependencies.store.run('DELETE FROM user_identities WHERE id = ? AND user_id = ?', [input.path.identityId, principal.id]);
			return { changed: true, id: input.path.identityId };
		} },
	];
}
