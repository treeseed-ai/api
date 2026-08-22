import { OperationRegistry } from './operation-registry.ts';
import { createAccountDeleteOperation, createAccountDeletionBlockersOperation, createAccountEmailAddOperation, createAccountEmailConfirmOperation, createAccountEmailPrimaryOperation, createAccountEmailRemoveOperation, createAccountEmailsOperation, createAccountEmailVerifyOperation, createAccountIdentityOperation, createAccountNotificationReadOperation, createAccountNotificationsOperation, createAccountPasswordResetCompleteOperation, createAccountPasswordResetRequestOperation, createAccountPasswordUpdateOperation, createAccountPreferencesOperation, createAccountPreferencesUpdateOperation, createAccountProfileUpdateOperation, createAccountRegisterOperation, createAccountSessionRevokeOperation, createAccountSessionsOperation, createCurrentAccountOperation, type AccountOperationDependencies } from './account-operations.ts';
import { createCapacityPlanOperations, type CapacityPlanOperationDependencies } from './capacity/plans.ts';
import { createAgentOperations, type AgentOperationDependencies } from './capacity/agents.ts';
import { createWorkdayOperations, type WorkdayOperationDependencies } from './capacity/workdays.ts';
import { createDeepHealthOperation, createReadinessOperation, statusOperation, type DeepHealthDependencies } from './core-operations.ts';
import { createDiscussionOperations, type DiscussionOperationDependencies } from './discussion-operations.ts';
import { createGovernanceOperations, type GovernanceOperationDependencies } from './governance-operations.ts';
import { createKnowledgeOperations, type KnowledgeOperationDependencies } from './knowledge-operations.ts';
import { createProjectAccessOperation, createProjectArchiveOperation, createProjectCreateOperation, createProjectDeleteOperation, createProjectDeletionBlockersOperation, createProjectRestoreOperation, createProjectShowOperation, createProjectSummaryOperation, createProjectsListOperation, type ProjectOperationDependencies } from './project-operations.ts';
import { createRepositoryOperations, type RepositoryOperationDependencies } from './repositories/index.ts';
import { createServiceOperations, type ServiceOperationDependencies } from './services/index.ts';
import { createTeamAccessOperation, createTeamArchiveOperation, createTeamCreateOperation, createTeamDeletionReadinessOperation, createTeamInviteAcceptOperation, createTeamInviteOperation, createTeamInvitesOperation, createTeamInviteShowOperation, createTeamLeaveOperation, createTeamMembersOperation, createTeamMemberRemoveOperation, createTeamMemberUpdateOperation, createTeamOwnershipTransferOperation, createTeamProfileOperation, createTeamRestoreOperation, createTeamsListOperation, createTeamUpdateOperation, type TeamOperationDependencies } from './team-operations.ts';

export * from './operation-registry.ts';

export const controlPlaneOperations = new OperationRegistry([statusOperation]);

export function createApiControlPlaneOperations(dependencies: DeepHealthDependencies & ProjectOperationDependencies & AccountOperationDependencies & TeamOperationDependencies & KnowledgeOperationDependencies & DiscussionOperationDependencies & GovernanceOperationDependencies & RepositoryOperationDependencies & ServiceOperationDependencies & CapacityPlanOperationDependencies & WorkdayOperationDependencies & AgentOperationDependencies) {
	return new OperationRegistry([
		statusOperation,
		createReadinessOperation(dependencies),
		createDeepHealthOperation(dependencies),
		createCurrentAccountOperation(dependencies),
		createAccountRegisterOperation(dependencies),
		createAccountEmailConfirmOperation(dependencies),
		createAccountPasswordResetRequestOperation(dependencies),
		createAccountPasswordResetCompleteOperation(dependencies),
		createAccountPasswordUpdateOperation(dependencies),
		createAccountDeletionBlockersOperation(dependencies),
		createAccountDeleteOperation(dependencies),
		...createKnowledgeOperations(dependencies),
		...createDiscussionOperations(dependencies),
		...createGovernanceOperations(dependencies),
		...createRepositoryOperations(dependencies),
		...createServiceOperations(dependencies),
		...createCapacityPlanOperations(dependencies),
		...createWorkdayOperations(dependencies),
		...createAgentOperations(dependencies),
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
