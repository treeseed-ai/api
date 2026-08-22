import { OperationRegistry } from './operation-registry.ts';
import { createAccountDeleteOperation, createAccountDeletionBlockersOperation, createAccountEmailAddOperation, createAccountEmailConfirmOperation, createAccountEmailPrimaryOperation, createAccountEmailRemoveOperation, createAccountEmailsOperation, createAccountEmailVerifyOperation, createAccountIdentityOperation, createAccountNotificationReadOperation, createAccountNotificationsOperation, createAccountPasswordResetCompleteOperation, createAccountPasswordResetRequestOperation, createAccountPasswordUpdateOperation, createAccountPreferencesOperation, createAccountPreferencesUpdateOperation, createAccountProfileUpdateOperation, createAccountRegisterOperation, createAccountSessionRevokeOperation, createAccountSessionsOperation, createCurrentAccountOperation, type AccountOperationDependencies } from './account-operations.ts';
import { createCapacityPlanOperations, type CapacityPlanOperationDependencies } from './capacity/plans.ts';
import { createPlanningAndEstimateOperations, type PlanningAndEstimateOperationDependencies } from './capacity/planning-and-estimates.ts';
import { createAgentGovernanceOperations, type AgentGovernanceOperationDependencies } from './capacity/agent-governance.ts';
import { createCommunicationOperations, type CommunicationOperationDependencies } from './capacity/communications.ts';
import { createAgentOperations, type AgentOperationDependencies } from './capacity/agents.ts';
import { createCapacityQueryOperations, type CapacityQueryOperationDependencies } from './capacity/capacity.ts';
import { createAssignmentOperations, type AssignmentOperationDependencies } from './capacity/assignments.ts';
import { createWorkdayOperations, type WorkdayOperationDependencies } from './capacity/workdays.ts';
import { createDeepHealthOperation, createReadinessOperation, statusOperation, type DeepHealthDependencies } from './core-operations.ts';
import { createDiscussionOperations, type DiscussionOperationDependencies } from './discussion-operations.ts';
import { createGovernanceOperations, type GovernanceOperationDependencies } from './governance-operations.ts';
import { createKnowledgeOperations, type KnowledgeOperationDependencies } from './knowledge-operations.ts';
import { createProjectAccessOperation, createProjectArchiveOperation, createProjectCreateOperation, createProjectDeleteOperation, createProjectDeletionBlockersOperation, createProjectRestoreOperation, createProjectShowOperation, createProjectSummaryOperation, createProjectUpdateOperation, createProjectsListOperation, type ProjectOperationDependencies } from './project-operations.ts';
import { createRepositoryOperations, type RepositoryOperationDependencies } from './repositories/index.ts';
import { createServiceOperations, type ServiceOperationDependencies } from './services/index.ts';
import { createPlatformOperations, type PlatformOperationDependencies } from './operations/index.ts';
import { createProviderRegistrationAndAvailabilityOperations, type ProviderOperationDependencies } from './providers/registration-and-availability.ts';
import { createProviderAssignmentOperations, type ProviderAssignmentOperationDependencies } from './providers/assignments.ts';
import { createTreeDxOperations, type TreeDxOperationDependencies } from './treedx/index.ts';
import { createRealtimeOperations, type RealtimeOperationDependencies } from './realtime/index.ts';
import { createSeedOperations, type SeedOperationDependencies } from './seeds/index.ts';
import { createFeedbackOperations, type FeedbackOperationDependencies } from './feedback/index.ts';
import { createTeamAccessOperation, createTeamArchiveOperation, createTeamCreateOperation, createTeamDeletionReadinessOperation, createTeamInviteAcceptOperation, createTeamInviteOperation, createTeamInvitesOperation, createTeamInviteShowOperation, createTeamLeaveOperation, createTeamMembersOperation, createTeamMemberRemoveOperation, createTeamMemberUpdateOperation, createTeamOwnershipTransferOperation, createTeamProfileOperation, createTeamRestoreOperation, createTeamsListOperation, createTeamUpdateOperation, type TeamOperationDependencies } from './team-operations.ts';

export * from './operation-registry.ts';

export const controlPlaneOperations = new OperationRegistry([statusOperation]);

export function createApiControlPlaneOperations(dependencies: DeepHealthDependencies & ProjectOperationDependencies & AccountOperationDependencies & TeamOperationDependencies & KnowledgeOperationDependencies & DiscussionOperationDependencies & GovernanceOperationDependencies & RepositoryOperationDependencies & ServiceOperationDependencies & CapacityPlanOperationDependencies & PlanningAndEstimateOperationDependencies & AgentGovernanceOperationDependencies & CommunicationOperationDependencies & WorkdayOperationDependencies & AgentOperationDependencies & CapacityQueryOperationDependencies & AssignmentOperationDependencies & PlatformOperationDependencies & ProviderOperationDependencies & ProviderAssignmentOperationDependencies & TreeDxOperationDependencies & RealtimeOperationDependencies & SeedOperationDependencies & FeedbackOperationDependencies) {
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
		...createPlanningAndEstimateOperations(dependencies),
		...createAgentGovernanceOperations(dependencies),
		...createCommunicationOperations(dependencies),
		...createWorkdayOperations(dependencies),
		...createAgentOperations(dependencies),
		...createCapacityQueryOperations(dependencies),
		...createAssignmentOperations(dependencies),
		...createPlatformOperations(dependencies),
		...createProviderRegistrationAndAvailabilityOperations(dependencies),
		...createProviderAssignmentOperations(dependencies),
		...createTreeDxOperations(dependencies),
		...createRealtimeOperations(dependencies),
		...createSeedOperations(dependencies),
		...createFeedbackOperations(dependencies),
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
		createProjectUpdateOperation(dependencies),
		createProjectArchiveOperation(dependencies),
		createProjectRestoreOperation(dependencies),
		createProjectDeletionBlockersOperation(dependencies),
		createProjectDeleteOperation(dependencies),
		createProjectAccessOperation(dependencies),
		createProjectSummaryOperation(dependencies),
	]);
}
