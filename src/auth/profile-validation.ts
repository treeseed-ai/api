export const RESERVED_USERNAMES = new Set([
	'app',
	'api',
	'auth',
	'market',
	'templates',
	'admin',
	'settings',
	'u',
	'users',
	'new',
	'me',
	'account',
	'login',
	'logout',
	'signup',
]);

export type UsernameValidationResult =
	| { ok: true; username: string }
	| { ok: false; code: 'missing' | 'format' | 'reserved'; message: string };

export function normalizeUsername(value: string | null | undefined) {
	return String(value ?? '').trim().toLowerCase();
}

export function composeDisplayNameFromParts(firstName: string | null | undefined, lastName: string | null | undefined) {
	return [firstName, lastName]
		.map((part) => String(part ?? '').trim())
		.filter(Boolean)
		.join(' ');
}

export function validateUsername(value: string | null | undefined): UsernameValidationResult {
	const username = normalizeUsername(value);
	if (!username) {
		return { ok: false, code: 'missing', message: 'Username is required.' };
	}
	if (RESERVED_USERNAMES.has(username)) {
		return { ok: false, code: 'reserved', message: 'That username is reserved.' };
	}
	if (
		username.length > 39
		|| !/^[a-z0-9-]+$/u.test(username)
		|| username.startsWith('-')
		|| username.endsWith('-')
		|| username.includes('--')
	) {
		return {
			ok: false,
			code: 'format',
			message: 'Usernames can use 1-39 letters, numbers, or single hyphens, with no leading or trailing hyphen.',
		};
	}
	return { ok: true, username };
}
