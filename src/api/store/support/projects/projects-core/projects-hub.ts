import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { governanceVotingProvider } from '@treeseed/sdk';
import { containsPlaintextSecretMaterial, validateClientEncryptedEscrowMetadata, validateSecretsCapabilityRegistry, validateWritableSecretMetadata, } from '@treeseed/sdk/secrets-capability';
import { redactDeploymentValue } from '../../../../../market/hosting/deployment-actions.ts';
import { projectDeploymentAuditPayload } from '../../../../../market/governance/policy/deployment-governance.ts';
import { parseJson } from '../../foundation.ts';
import { PROJECT_ARCHITECTURE_TOPOLOGIES, LEGACY_PROJECT_TOPOLOGIES, projectArchitectureError, normalizeProjectPath, normalizeProjectContentPublishTarget, normalizeProjectArchitecture, projectArchitectureContentSource, projectDeletionConfirmationMatches, normalizeProjectSlug, validateProjectSlug, serializeProject, summarizeProjectHealth, serializeConnection, serializeRepositoryHost, serializeHubRepository, serializeProjectUpdatePlan, serializePlatformRepositoryClaim, platformRepositoryKey, platformRepositoryWorkspacePath, serializeGitHubRepositoryGrant, serializeProjectEnvironment, serializeProjectSummarySnapshot } from '../../index.ts';

export function serializeHubContentSource(row) {
    if (!row)
        return null;
    return {
        id: row.id,
        hubId: row.hub_id,
        teamId: row.team_id,
        contentRepositoryId: row.content_repository_id,
        productionSource: row.production_source,
        overlayPolicy: row.overlay_policy,
        r2BucketName: row.r2_bucket_name,
        r2ManifestKey: row.r2_manifest_key,
        r2PublicBaseUrl: row.r2_public_base_url,
        latestPublishId: row.latest_publish_id,
        latestContentVersion: row.latest_content_version,
        metadata: parseJson(row.metadata_json, {}),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

export function serializeHubLaunch(row) {
    if (!row)
        return null;
    return {
        id: row.id,
        hubId: row.hub_id,
        teamId: row.team_id,
        jobId: row.job_id,
        intent: parseJson(row.intent_json, {}),
        plan: parseJson(row.plan_json, {}),
        state: row.state,
        currentPhase: row.current_phase,
        lastSuccessfulPhase: row.last_successful_phase,
        result: parseJson(row.result_json, null),
        error: parseJson(row.error_json, null),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        completedAt: row.completed_at,
    };
}

export function serializeHubLaunchEvent(row) {
    if (!row)
        return null;
    return {
        id: row.id,
        launchId: row.launch_id,
        seq: Number(row.seq ?? 0),
        phase: row.phase,
        status: row.status,
        title: row.title,
        summary: row.summary,
        startedAt: row.started_at,
        finishedAt: row.finished_at,
        error: parseJson(row.error_json, null),
        data: parseJson(row.data_json, {}),
        createdAt: row.created_at,
    };
}

export function serializeHubWorkspaceLink(row) {
    if (!row)
        return null;
    return {
        id: row.id,
        hubId: row.hub_id,
        teamId: row.team_id,
        parentRepositoryHostId: row.parent_repository_host_id,
        parentOwner: row.parent_owner,
        parentName: row.parent_name,
        parentUrl: row.parent_url,
        parentBranch: row.parent_branch,
        hubMountPath: row.hub_mount_path,
        softwareSubmodulePath: row.software_submodule_path,
        contentSubmodulePath: row.content_submodule_path,
        updateSubmodulePointersEnabled: Boolean(row.update_submodule_pointers_enabled),
        accessPolicy: parseJson(row.access_policy_json, {}),
        metadata: parseJson(row.metadata_json, {}),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

export function serializeGitHubAppInstallationRecord(row) {
    if (!row)
        return null;
    return {
        id: row.id,
        teamId: row.team_id,
        installationId: row.installation_id,
        accountLogin: row.account_login,
        accountId: row.account_id,
        accountType: row.account_type,
        status: row.status,
        permissions: parseJson(row.permissions_json, {}),
        repositorySelection: row.repository_selection,
        driftCode: row.drift_code,
        observedAt: row.observed_at,
        revokedAt: row.revoked_at,
        suspendedAt: row.suspended_at,
        metadata: redactDeploymentValue(parseJson(row.metadata_json, {})),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

export function serializeGitHubAppTokenIssuanceRecord(row) {
    if (!row)
        return null;
    return {
        id: row.id,
        teamId: row.team_id,
        projectId: row.project_id,
        assignmentId: row.assignment_id,
        providerId: row.provider_id,
        workdayId: row.workday_id,
        operationId: row.operation_id,
        repository: row.repository,
        installationId: row.installation_id,
        status: row.status,
        tokenPrefix: row.token_prefix,
        tokenHash: row.token_hash,
        permissions: parseJson(row.permissions_json, {}),
        allowedOperations: parseJson(row.allowed_operations_json, []),
        expiresAt: row.expires_at,
        issuedAt: row.issued_at,
        revokedAt: row.revoked_at,
        failClosedCode: row.fail_closed_code,
        metadata: redactDeploymentValue(parseJson(row.metadata_json, {})),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}
