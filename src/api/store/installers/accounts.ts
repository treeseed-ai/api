import type { MarketControlPlaneStore } from '../../persistence/store.ts';
import { createTrustedUserAssertionMethod } from '../support/creation/create-trusted-user-assertion.ts';
import { publicUsernameExistsMethod } from '../accounts/contracts/public-username-exists.ts';
import { findUserByEmailMethod } from '../accounts/queries/find-user-by-email.ts';
import { listActiveUsersMethod } from '../support/queries/list-active-users.ts';
import { loadUserProfileByUsernameMethod } from '../accounts/queries/load-user-profile-by-username.ts';

export function installAccountsStoreMethods(prototype: MarketControlPlaneStore) {
	prototype.createTrustedUserAssertion = createTrustedUserAssertionMethod;
	prototype.publicUsernameExists = publicUsernameExistsMethod;
	prototype.findUserByEmail = findUserByEmailMethod;
	prototype.listActiveUsers = listActiveUsersMethod;
	prototype.loadUserProfileByUsername = loadUserProfileByUsernameMethod;
}
