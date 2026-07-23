import type { MarketControlPlaneStore } from '../../store.ts';
import { createTrustedUserAssertionMethod } from '../create-trusted-user-assertion.ts';
import { publicUsernameExistsMethod } from '../public-username-exists.ts';
import { findUserByEmailMethod } from '../find-user-by-email.ts';
import { listActiveUsersMethod } from '../list-active-users.ts';
import { loadUserProfileByUsernameMethod } from '../load-user-profile-by-username.ts';

export function installAccountsStoreMethods(prototype: MarketControlPlaneStore) {
	prototype.createTrustedUserAssertion = createTrustedUserAssertionMethod;
	prototype.publicUsernameExists = publicUsernameExistsMethod;
	prototype.findUserByEmail = findUserByEmailMethod;
	prototype.listActiveUsers = listActiveUsersMethod;
	prototype.loadUserProfileByUsername = loadUserProfileByUsernameMethod;
}
