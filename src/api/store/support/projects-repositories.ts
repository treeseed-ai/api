import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { governanceVotingProvider } from '@treeseed/sdk';
import { containsTreeseedPlaintextSecretMaterial, validateTreeseedClientEncryptedEscrowMetadata, validateTreeseedSecretsCapabilityRegistry, validateTreeseedWritableSecretMetadata, } from '@treeseed/sdk/secrets-capability';
import { redactDeploymentValue } from '../../../market/deployment-actions.ts';
import { projectDeploymentAuditPayload } from '../../../market/deployment-governance.ts';
import { parseJson } from './foundation.ts';
import { PROJECT_ARCHITECTURE_TOPOLOGIES, LEGACY_PROJECT_TOPOLOGIES, projectArchitectureError, normalizeProjectPath, normalizeProjectContentPublishTarget, normalizeProjectArchitecture, projectArchitectureContentSource, projectDeletionConfirmationMatches, normalizeProjectSlug, validateProjectSlug, serializeProject, summarizeProjectHealth, serializeHubContentSource, serializeHubLaunch, serializeHubLaunchEvent, serializeHubWorkspaceLink, serializeProjectUpdatePlan, serializeGitHubAppInstallationRecord, serializeGitHubAppTokenIssuanceRecord, serializeProjectEnvironment, serializeProjectSummarySnapshot } from './index.ts';

export function serializeConnection(row) {
    if (!row)
        return null;
    return {
        id: row.id,
        projectId: row.project_id,
        mode: row.mode,
        projectApiBaseUrl: row.project_api_base_url,
        runnerRegistrationState: row.runner_registration_state,
        executionOwner: row.execution_owner,
        runnerRegisteredAt: row.runner_registered_at,
        runnerLastSeenAt: row.runner_last_seen_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        metadata: parseJson(row.metadata_json, {}),
    };
}

export function serializeRepositoryHost(row) {
    if (!row)
        return null;
    return {
        id: row.id,
        teamId: row.team_id,
        provider: row.provider,
        ownership: row.ownership,
        name: row.name,
        accountLabel: row.account_label,
        organizationOrOwner: row.organization_or_owner,
        defaultVisibility: row.default_visibility,
        softwareRepositoryNameTemplate: row.software_repository_name_template,
        contentRepositoryNameTemplate: row.content_repository_name_template,
        branchPolicy: parseJson(row.branch_policy_json, {}),
        workflowPolicy: parseJson(row.workflow_policy_json, {}),
        encryptedPayload: parseJson(row.encrypted_payload_json, null),
        allowedProjectKinds: parseJson(row.allowed_project_kinds_json, []),
        status: row.status,
        metadata: parseJson(row.metadata_json, {}),
        createdById: row.created_by_id,
        updatedById: row.updated_by_id,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

export function serializeHubRepository(row) {
    if (!row)
        return null;
    return {
        id: row.id,
        hubId: row.hub_id,
        teamId: row.team_id,
        role: row.role,
        repositoryHostId: row.repository_host_id,
        provider: row.provider,
        owner: row.owner,
        name: row.name,
        url: row.url,
        defaultBranch: row.default_branch,
        currentBranch: row.current_branch,
        status: row.status,
        accessPolicy: parseJson(row.access_policy_json, {}),
        releasePolicy: parseJson(row.release_policy_json, {}),
        publishPolicy: parseJson(row.publish_policy_json, {}),
        submodulePath: row.submodule_path,
        metadata: parseJson(row.metadata_json, {}),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

export function serializePlatformRepositoryClaim(row) {
    if (!row)
        return null;
    return {
        id: row.id,
        repositoryKey: row.repository_key,
        runnerId: row.runner_id,
        workspacePath: row.workspace_path,
        branch: row.branch,
        commitSha: row.commit_sha,
        claimState: row.claim_state,
        leaseExpiresAt: row.lease_expires_at,
        metadata: parseJson(row.metadata_json, {}),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

export function platformRepositoryKey(repository: any = {}) {
    return [repository.provider ?? 'git', repository.owner ?? 'local', repository.name ?? 'repository']
        .join('-')
        .toLowerCase()
        .replace(/[^a-z0-9.-]+/gu, '-')
        .replace(/^-+|-+$/gu, '') || 'repository';
}

export function platformRepositoryWorkspacePath(workspaceRoot, repository: any = {}) {
    const root = String(workspaceRoot ?? '/data').replace(/\/+$/u, '') || '/data';
    return `${root}/repositories/${platformRepositoryKey(repository)}/repo`;
}

export function serializeGitHubRepositoryGrant(row) {
    if (!row)
        return null;
    return {
        id: row.id,
        teamId: row.team_id,
        projectId: row.project_id,
        repository: row.repository,
        installationId: row.installation_id,
        accountLogin: row.account_login,
        accountId: row.account_id,
        status: row.status,
        permissions: parseJson(row.permissions_json, {}),
        environments: parseJson(row.environments_json, []),
        driftCode: row.drift_code,
        observedAt: row.observed_at,
        revokedAt: row.revoked_at,
        metadata: redactDeploymentValue(parseJson(row.metadata_json, {})),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}
