import {
	createControlPlaneEmailConfirmation,
	createOrResendUserEmailAddress,
	getUserEmailAddress,
	listUserEmailAddresses,
	serializeUserEmailAddress,
	setPrimaryEmailAddress,
	syncPrimaryEmailCaches,
	verifiedEmailCount,
} from '../../app/support/index.ts';

export function createAccountEmailService(store: any, emailContext: any) {
	return {
		async add(user: Record<string, any>, email: unknown) {
			return createOrResendUserEmailAddress(store, emailContext, user.id, {
				email, displayName: user.displayName, returnTo: '/app/account',
			});
		},
		async verify(user: Record<string, any>, emailId: string) {
			const row = await getUserEmailAddress(store, user.id, emailId);
			if (!row) return { ok: false, status: 404, code: 'email_missing', message: 'The email address was not found.' };
			if (row.status === 'verified') return { ok: true, emailAddress: row, verificationSent: false };
			await createControlPlaneEmailConfirmation(store, emailContext, {
				email: row.email, emailAddressId: row.id, displayName: user.displayName, returnTo: '/app/account',
			});
			return { ok: true, emailAddress: serializeUserEmailAddress(await getUserEmailAddress(store, user.id, row.id)), verificationSent: true };
		},
		async makePrimary(user: Record<string, any>, emailId: string) {
			return setPrimaryEmailAddress(store, user.id, emailId);
		},
		async remove(user: Record<string, any>, emailId: string) {
			const row = await getUserEmailAddress(store, user.id, emailId);
			if (!row) return { ok: false, status: 404, code: 'email_missing', message: 'The email address was not found.' };
			if (row.status === 'verified' && await verifiedEmailCount(store, user.id) <= 1) {
				return { ok: false, status: 409, code: 'last_verified_email', message: 'At least one verified email is required.' };
			}
			await store.run('DELETE FROM user_email_addresses WHERE id = ? AND user_id = ?', [row.id, user.id]);
			if (row.status === 'verified' && row.isPrimary) await syncPrimaryEmailCaches(store, user.id);
			return { ok: true, items: await listUserEmailAddresses(store, user.id) };
		},
	};
}
