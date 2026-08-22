import { OperationRegistry } from './operation-registry.ts';
import { createAccountEmailAddOperation, createAccountEmailPrimaryOperation, createAccountEmailRemoveOperation, createAccountEmailsOperation, createAccountEmailVerifyOperation, createAccountIdentityOperation, createAccountNotificationReadOperation, createAccountNotificationsOperation, createAccountPreferencesOperation, createAccountPreferencesUpdateOperation, createAccountProfileUpdateOperation, createAccountSessionRevokeOperation, createAccountSessionsOperation, createCurrentAccountOperation, type AccountOperationDependencies } from './account-operations.ts';
import { createDeepHealthOperation, createReadinessOperation, statusOperation, type DeepHealthDependencies } from './core-operations.ts';
import { createProjectAccessOperation, createProjectArchiveOperation, createProjectCreateOperation, createProjectDeleteOperation, createProjectDeletionBlockersOperation, createProjectRestoreOperation, createProjectShowOperation, createProjectSummaryOperation, createProjectsListOperation, type ProjectOperationDependencies } from './project-operations.ts';
import { createTeamAccessOperation, createTeamArchiveOperation, createTeamCreateOperation, createTeamDeletionReadinessOperation, createTeamInviteAcceptOperation, createTeamInviteOperation, createTeamInvitesOperation, createTeamInviteShowOperation, createTeamLeaveOperation, createTeamMembersOperation, createTeamMemberRemoveOperation, createTeamMemberUpdateOperation, createTeamOwnershipTransferOperation, createTeamProfileOperation, createTeamRestoreOperation, createTeamsListOperation, createTeamUpdateOperation, type TeamOperationDependencies } from './team-operations.ts';

export * from './operation-registry.ts';

export const controlPlaneOperations = new OperationRegistry([statusOperation]);

export function createApiControlPlaneOperations(dependencies: DeepHealthDependencies & ProjectOperationDependencies & AccountOperationDependencies & TeamOperationDependencies) {
	return new OperationRegistry([
		statusOperation,
		createReadinessOperation(dependencies),
		createDeepHealthOperation(dependencies),
		createCurrentAccountOperation(dependencies),
		createAccountIdentityOperation(dependencies),
		createAccountEmailsOperation(dependencies),
		createAccountEmailAddOperation(dependencies),
		createAccountEmailVerifyOperation(dependencies),
		createAccountEmailPrimaryOperation(dependencies),
		createAccountEmailRemoveOperation(dependencies),
		createAccountSessionsOperation(dependencies),
		createAccountSessionRevokeOperation(dependencies),
		createAccountProfileUpdateOperation(dependencies),
		createAccountPreferencesOperation(dependencies),
		createAccountPreferencesUpdateOperation(dependencies),
		createAccountNotificationsOperation(dependencies),
		createAccountNotificationReadOperation(dependencies),
		createTeamsListOperation(dependencies),
		createTeamProfileOperation(dependencies),
		createTeamCreateOperation(dependencies),
		createTeamUpdateOperation(dependencies),
		createTeamMemberUpdateOperation(dependencies),
		createTeamMemberRemoveOperation(dependencies),
		createTeamArchiveOperation(dependencies),
		createTeamRestoreOperation(dependencies),
		createTeamOwnershipTransferOperation(dependencies),
		createTeamLeaveOperation(dependencies),
		createTeamAccessOperation(dependencies),
		createTeamMembersOperation(dependencies),
		createTeamInviteOperation(dependencies),
		createTeamInvitesOperation(dependencies),
		createTeamInviteShowOperation(dependencies),
		createTeamInviteAcceptOperation(dependencies),
		createTeamDeletionReadinessOperation(dependencies),
		createProjectsListOperation(dependencies),
		createProjectShowOperation(dependencies),
		createProjectCreateOperation(dependencies),
		createProjectArchiveOperation(dependencies),
		createProjectRestoreOperation(dependencies),
		createProjectDeletionBlockersOperation(dependencies),
		createProjectDeleteOperation(dependencies),
		createProjectAccessOperation(dependencies),
		createProjectSummaryOperation(dependencies),
	]);
}
