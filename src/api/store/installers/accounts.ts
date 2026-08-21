import type { ControlPlaneStore } from '../../persistence/store.ts';
import { publicUsernameExistsMethod } from '../accounts/contracts/public-username-exists.ts';
import { findUserByEmailMethod } from '../accounts/queries/find-user-by-email.ts';
import { loadUserProfileByUsernameMethod } from '../accounts/queries/load-user-profile-by-username.ts';
import { createTrustedUserAssertionMethod } from '../support/creation/create-trusted-user-assertion.ts';
import { listActiveUsersMethod } from '../support/queries/list-active-users.ts';

export function installAccountsStoreMethods(prototype: ControlPlaneStore) {
	prototype.createTrustedUserAssertion = createTrustedUserAssertionMethod;
	prototype.publicUsernameExists = publicUsernameExistsMethod;
	prototype.findUserByEmail = findUserByEmailMethod;
	prototype.listActiveUsers = listActiveUsersMethod;
	prototype.loadUserProfileByUsername = loadUserProfileByUsernameMethod;
}
