import type { MarketControlPlaneStore } from '../../persistence/store.ts';
import { authenticateTeamApiKeyMethod } from '../teams/contracts/authenticate-team-api-key.ts';
import { ensurePersonalResearchTeamForUserMethod } from '../teams/contracts/ensure-personal-research-team-for-user.ts';
import { evaluateTeamDeletionBlockersMethod } from '../teams/contracts/evaluate-team-deletion-blockers.ts';
import { membershipOwnerCountMethod } from '../teams/contracts/membership-owner-count.ts';
import { principalCanAccessTeamMethod } from '../teams/contracts/principal-can-access-team.ts';
import { principalCanManageTeamMethod } from '../teams/contracts/principal-can-manage-team.ts';
import { roleIdForKeyMethod } from '../teams/contracts/role-id-for-key.ts';
import { seedTeamRolesMethod } from '../teams/contracts/seed-team-roles.ts';
import { teamIdsForPrincipalMethod } from '../teams/contracts/team-ids-for-principal.ts';
import { syncPlatformAdminOwnersMethod } from '../teams/contracts/administration/sync-platform-admin-owners.ts';
import { claimSeedTeamMembershipsForVerifiedEmailMethod,getSeedTeamMembershipClaimMethod,reconcileSeedTeamMembershipClaimMethod,retireUndeclaredSeedTeamMembershipClaimsMethod } from '../teams/contracts/seeding/seed-membership-claims.ts';
import { teamPublicNameExistsMethod } from '../teams/contracts/team-public-name-exists.ts';
import { createTeamApiKeyMethod } from '../teams/creation/create-team-api-key.ts';
import { createTeamInviteMethod } from '../teams/creation/create-team-invite.ts';
import { createTeamMethod } from '../teams/creation/create-team.ts';
import { prepareTeamDeletionMethod } from '../teams/creation/prepare-team-deletion.ts';
import { upsertTeamInboxItemMethod } from '../teams/creation/upsert-team-inbox-item.ts';
import { upsertTeamMemberMethod } from '../teams/creation/upsert-team-member.ts';
import { upsertTeamStorageLocatorMethod } from '../teams/creation/upsert-team-storage-locator.ts';
import { acceptTeamInviteMethod } from '../teams/lifecycle/accept-team-invite.ts';
import { resendTeamInviteMethod } from '../teams/lifecycle/manage-team-invitation.ts';
import { archiveTeamMethod,getTeamDeletionReadinessMethod,restoreTeamMethod } from '../teams/lifecycle/manage-team-lifecycle.ts';
import { leaveTeamMethod,transferTeamOwnershipMethod } from '../teams/lifecycle/manage-team-ownership.ts';
import { getTeamAccessSummaryMethod } from '../teams/queries/access/get-team-access-summary.ts';
import { listTeamsForPrincipalMethod } from '../teams/queries/access/list-teams-for-principal.ts';
import { resolvePrincipalTeamContextMethod } from '../teams/queries/access/resolve-principal-team-context.ts';
import { getTeamStorageLocatorMethod } from '../teams/queries/hosting/get-team-storage-locator.ts';
import { getTeamByNameMethod } from '../teams/queries/identity/get-team-by-name.ts';
import { getTeamBySlugMethod } from '../teams/queries/identity/get-team-by-slug.ts';
import { getTeamHomeSummaryMethod } from '../teams/queries/identity/get-team-home-summary.ts';
import { getTeamMethod } from '../teams/queries/identity/get-team.ts';
import { isTeamNameAvailableMethod } from '../teams/queries/identity/is-team-name-available.ts';
import { loadTeamProfileByNameMethod } from '../teams/queries/identity/load-team-profile-by-name.ts';
import { listPersistedTeamInboxItemsMethod } from '../teams/queries/inbox/list-persisted-team-inbox-items.ts';
import { listTeamInboxItemsMethod } from '../teams/queries/inbox/list-team-inbox-items.ts';
import { getPendingTeamInviteByTokenMethod } from '../teams/queries/invites/get-pending-team-invite-by-token.ts';
import { getTeamInviteByTokenMethod } from '../teams/queries/invites/get-team-invite-by-token.ts';
import { getTeamInviteMethod } from '../teams/queries/invites/get-team-invite.ts';
import { listTeamInvitesMethod } from '../teams/queries/invites/list-team-invites.ts';
import { listRoleKeysForMembershipMethod } from '../teams/queries/members/list-role-keys-for-membership.ts';
import { listTeamMembersMethod } from '../teams/queries/members/list-team-members.ts';
import { deleteTeamInboxItemMethod } from '../teams/retirement/delete-team-inbox-item.ts';
import { deleteTeamInboxItemsByItemKeyMethod } from '../teams/retirement/delete-team-inbox-items-by-item-key.ts';
import { removeTeamMemberMethod } from '../teams/retirement/remove-team-member.ts';
import { revokeTeamInviteMethod } from '../teams/retirement/revoke-team-invite.ts';
import {
createExternalVaultBindingMethod,
listExternalVaultBindingsMethod,
removeExternalVaultBindingMethod,
} from '../teams/services/external-vault-bindings.ts';
import {
cancelSecretOperationLeaseMethod,
consumeSecretOperationLeaseMethod,
createSecretOperationLeaseMethod,
getSecretOperationLeaseMethod,
listAwaitingSecretOperationLeasesMethod,
registerSecretOperationLeaseKeyMethod,
submitSecretOperationPayloadMethod,
} from '../teams/services/secret-operation-leases.ts';
import {
createTeamServiceConnectionMethod,
disconnectTeamServiceConnectionMethod,
getTeamServiceConnectionMethod,
listTeamServiceConnectionsMethod,
updateTeamServiceConnectionMethod,
upsertTeamServiceCapabilityMethod,
} from '../teams/services/service-connections.ts';
import { principalCanManageServicesMethod,principalCanManageServiceVaultMethod } from '../teams/services/service-permissions.ts';
import {
createTeamVaultGrantMethod,
getTeamVaultSummaryMethod,
getUserVaultKeyMethod,
initializeTeamVaultMethod,
listServiceCredentialEnvelopesMethod,
listTeamCredentialEnvelopesMethod,
resetTeamVaultMethod,
revokeTeamVaultGrantMethod,
rotateTeamVaultMethod,
upsertServiceCredentialEnvelopeMethod,
upsertUserVaultKeyMethod,
} from '../teams/services/service-vaults.ts';
import { bindRoleToMembershipMethod } from '../teams/updates/bind-role-to-membership.ts';
import { replaceMembershipRoleMethod } from '../teams/updates/replace-membership-role.ts';
import { updateTeamMemberRoleMethod } from '../teams/updates/update-team-member-role.ts';
import { updateTeamSettingsMethod } from '../teams/updates/update-team-settings.ts';

export function installTeamsStoreMethods(prototype: MarketControlPlaneStore) {
	prototype.seedTeamRoles = seedTeamRolesMethod;
	prototype.syncPlatformAdminOwners = syncPlatformAdminOwnersMethod;
	prototype.getSeedTeamMembershipClaim = getSeedTeamMembershipClaimMethod;
	prototype.reconcileSeedTeamMembershipClaim = reconcileSeedTeamMembershipClaimMethod;
	prototype.claimSeedTeamMembershipsForVerifiedEmail = claimSeedTeamMembershipsForVerifiedEmailMethod;
	prototype.retireUndeclaredSeedTeamMembershipClaims = retireUndeclaredSeedTeamMembershipClaimsMethod;
	prototype.roleIdForKey = roleIdForKeyMethod;
	prototype.bindRoleToMembership = bindRoleToMembershipMethod;
	prototype.listRoleKeysForMembership = listRoleKeysForMembershipMethod;
	prototype.resolvePrincipalTeamContext = resolvePrincipalTeamContextMethod;
	prototype.getTeamAccessSummary = getTeamAccessSummaryMethod;
	prototype.teamIdsForPrincipal = teamIdsForPrincipalMethod;
	prototype.principalCanAccessTeam = principalCanAccessTeamMethod;
	prototype.principalCanManageTeam = principalCanManageTeamMethod;
	prototype.principalCanManageServices = principalCanManageServicesMethod;
	prototype.principalCanManageServiceVault = principalCanManageServiceVaultMethod;
	prototype.authenticateTeamApiKey = authenticateTeamApiKeyMethod;
	prototype.createTeam = createTeamMethod;
	prototype.getTeam = getTeamMethod;
	prototype.getTeamBySlug = getTeamBySlugMethod;
	prototype.getTeamByName = getTeamByNameMethod;
	prototype.isTeamNameAvailable = isTeamNameAvailableMethod;
	prototype.teamPublicNameExists = teamPublicNameExistsMethod;
	prototype.ensurePersonalResearchTeamForUser = ensurePersonalResearchTeamForUserMethod;
	prototype.updateTeamSettings = updateTeamSettingsMethod;
	prototype.listTeamsForPrincipal = listTeamsForPrincipalMethod;
	prototype.listTeamMembers = listTeamMembersMethod;
	prototype.listTeamInvites = listTeamInvitesMethod;
	prototype.membershipOwnerCount = membershipOwnerCountMethod;
	prototype.upsertTeamMember = upsertTeamMemberMethod;
	prototype.replaceMembershipRole = replaceMembershipRoleMethod;
	prototype.updateTeamMemberRole = updateTeamMemberRoleMethod;
	prototype.removeTeamMember = removeTeamMemberMethod;
	prototype.createTeamInvite = createTeamInviteMethod;
	prototype.getTeamInvite = getTeamInviteMethod;
	prototype.getPendingTeamInviteByToken = getPendingTeamInviteByTokenMethod;
	prototype.getTeamInviteByToken = getTeamInviteByTokenMethod;
	prototype.revokeTeamInvite = revokeTeamInviteMethod;
	prototype.acceptTeamInvite = acceptTeamInviteMethod;
	prototype.resendTeamInvite = resendTeamInviteMethod;
	prototype.archiveTeam = archiveTeamMethod;
	prototype.restoreTeam = restoreTeamMethod;
	prototype.getTeamDeletionReadiness = getTeamDeletionReadinessMethod;
	prototype.transferTeamOwnership = transferTeamOwnershipMethod;
	prototype.leaveTeam = leaveTeamMethod;
	prototype.createTeamApiKey = createTeamApiKeyMethod;
	prototype.getTeamStorageLocator = getTeamStorageLocatorMethod;
	prototype.upsertTeamStorageLocator = upsertTeamStorageLocatorMethod;
	prototype.loadTeamProfileByName = loadTeamProfileByNameMethod;
	prototype.evaluateTeamDeletionBlockers = evaluateTeamDeletionBlockersMethod;
	prototype.prepareTeamDeletion = prepareTeamDeletionMethod;
	prototype.listPersistedTeamInboxItems = listPersistedTeamInboxItemsMethod;
	prototype.upsertTeamInboxItem = upsertTeamInboxItemMethod;
	prototype.deleteTeamInboxItem = deleteTeamInboxItemMethod;
	prototype.deleteTeamInboxItemsByItemKey = deleteTeamInboxItemsByItemKeyMethod;
	prototype.listTeamInboxItems = listTeamInboxItemsMethod;
	prototype.getTeamHomeSummary = getTeamHomeSummaryMethod;
	prototype.listTeamServiceConnections = listTeamServiceConnectionsMethod;
	prototype.getTeamServiceConnection = getTeamServiceConnectionMethod;
	prototype.createTeamServiceConnection = createTeamServiceConnectionMethod;
	prototype.updateTeamServiceConnection = updateTeamServiceConnectionMethod;
	prototype.upsertTeamServiceCapability = upsertTeamServiceCapabilityMethod;
	prototype.disconnectTeamServiceConnection = disconnectTeamServiceConnectionMethod;
	prototype.getUserVaultKey = getUserVaultKeyMethod;
	prototype.upsertUserVaultKey = upsertUserVaultKeyMethod;
	prototype.getTeamVaultSummary = getTeamVaultSummaryMethod;
	prototype.initializeTeamVault = initializeTeamVaultMethod;
	prototype.createTeamVaultGrant = createTeamVaultGrantMethod;
	prototype.revokeTeamVaultGrant = revokeTeamVaultGrantMethod;
	prototype.resetTeamVault = resetTeamVaultMethod;
	prototype.upsertServiceCredentialEnvelope = upsertServiceCredentialEnvelopeMethod;
	prototype.listServiceCredentialEnvelopes = listServiceCredentialEnvelopesMethod;
	prototype.listTeamCredentialEnvelopes = listTeamCredentialEnvelopesMethod;
	prototype.rotateTeamVault = rotateTeamVaultMethod;
	prototype.createSecretOperationLease = createSecretOperationLeaseMethod;
	prototype.listAwaitingSecretOperationLeases = listAwaitingSecretOperationLeasesMethod;
	prototype.registerSecretOperationLeaseKey = registerSecretOperationLeaseKeyMethod;
	prototype.getSecretOperationLease = getSecretOperationLeaseMethod;
	prototype.submitSecretOperationPayload = submitSecretOperationPayloadMethod;
	prototype.consumeSecretOperationLease = consumeSecretOperationLeaseMethod;
	prototype.cancelSecretOperationLease = cancelSecretOperationLeaseMethod;
	prototype.listExternalVaultBindings = listExternalVaultBindingsMethod;
	prototype.createExternalVaultBinding = createExternalVaultBindingMethod;
	prototype.removeExternalVaultBinding = removeExternalVaultBindingMethod;
}
