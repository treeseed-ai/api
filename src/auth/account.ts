import {
	RESERVED_USERNAMES,
	composeDisplayNameFromParts,
	normalizeUsername,
	validateUsername,
	type UsernameValidationResult,
} from './profile-validation.ts';
import { DELETE_ACCOUNT_CONFIRMATION } from './delete-confirmation.ts';

export { RESERVED_USERNAMES, composeDisplayNameFromParts, normalizeUsername, validateUsername };
export type { UsernameValidationResult };
export { DELETE_ACCOUNT_CONFIRMATION };

export interface AccountProfileInput {
	name: string;
	image: string | null;
}

export interface AccountDeletionBlocker {
	code: 'platform_admin' | 'team_owner';
	message: string;
	teamId?: string;
	teamSlug?: string;
	teamName?: string;
}

export type UsernameAvailabilityStatus = 'empty' | 'invalid' | 'reserved' | 'taken' | 'available' | 'error';

export interface UsernameAvailabilityResult {
	ok: true;
	username: string;
	available: boolean;
	status: UsernameAvailabilityStatus;
	message: string;
}

export interface PublicUserProfile {
	user: {
		id: string;
		username: string;
		displayName: string | null;
		email: string | null;
		image: string | null;
		joinedAt: string;
	};
	activity: {
		teams: Array<{ id: string; slug: string; name: string; createdAt?: string }>;
		projects: Array<{ id: string; teamId: string; slug: string; name: string; description?: string | null; createdAt?: string }>;
		catalogItems: Array<{ id: string; teamId: string; kind: string; slug: string; title: string; summary?: string | null; visibility?: string }>;
		knowledgePacks: Array<{ id: string; teamId: string; slug: string; name: string; summary?: string | null; visibility?: string }>;
	};
}

function normalizeOptionalString(value: FormDataEntryValue | null) {
	const normalized = typeof value === 'string' ? value.trim() : '';
	return normalized || null;
}

export function normalizeAccountProfileInput(form: FormData): AccountProfileInput {
	return {
		name: normalizeOptionalString(form.get('name')) ?? '',
		image: normalizeOptionalString(form.get('image')),
	};
}

export function isValidProfileImageUrl(value: string | null | undefined) {
	if (!value) return true;
	try {
		const url = new URL(value);
		return url.protocol === 'https:';
	} catch {
		return false;
	}
}

export function accountDeletionConfirmationMatches(value: string | null | undefined) {
	return value === DELETE_ACCOUNT_CONFIRMATION;
}

export function accountStatusRedirect(statusKey: 'profile' | 'email' | 'delete', status: string) {
	return `/app/account?${statusKey}=${encodeURIComponent(status)}`;
}
