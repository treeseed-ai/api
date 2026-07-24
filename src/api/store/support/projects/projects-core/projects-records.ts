import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { governanceVotingProvider } from '@treeseed/sdk';
import { containsPlaintextSecretMaterial, validateClientEncryptedEscrowMetadata, validateSecretsCapabilityRegistry, validateWritableSecretMetadata, } from '@treeseed/sdk/secrets-capability';
import { redactDeploymentValue } from '../../../../../market/hosting/deployment-actions.ts';
import { projectDeploymentAuditPayload } from '../../../../../market/governance/policy/deployment-governance.ts';
import { CONTENT_PUBLISH_TARGETS, CONTENT_RUNTIME_SOURCES, LOCAL_CONTENT_MATERIALIZATIONS, parseJson } from '../../foundation.ts';
import { TEAM_DELETION_CONFIRMATION_PREFIX } from '../../teams/teams.ts';
import { serializeConnection, serializeRepositoryHost, serializeHubRepository, serializeHubContentSource, serializeHubLaunch, serializeHubLaunchEvent, serializeHubWorkspaceLink, serializePlatformRepositoryClaim, platformRepositoryKey, platformRepositoryWorkspacePath, serializeGitHubRepositoryGrant, serializeGitHubAppInstallationRecord, serializeGitHubAppTokenIssuanceRecord } from '../../index.ts';

export const PROJECT_ARCHITECTURE_TOPOLOGIES = new Set(['single_repository_site', 'split_site_content', 'parent_workspace']);

export const LEGACY_PROJECT_TOPOLOGIES = new Set(['split_software_content', 'combined_compatibility']);

export interface ProjectContentPublishTarget {
    kind: string;
    bucket?: string;
    prefix?: string;
    manifestPath?: string;
    metadata?: Record<string, unknown>;
}

export interface ProjectArchitecture extends Record<string, unknown> {
    topology: string;
    rootPath: string;
    sitePath: string;
    contentPath?: string;
    contentRuntimeSource: string;
    localContentMaterialization: string;
    contentPublishTarget?: ProjectContentPublishTarget;
    requiresLocalContentForCi?: boolean;
    requiresLocalContentForDeploy?: boolean;
}

export function projectArchitectureError(message, code = 'invalid_project_architecture') {
    const error: Error & Record<string, any> = new Error(message);
    error.code = code;
    return error;
}

export function normalizeProjectPath(value, fallback) {
    const text = typeof value === 'string' ? value.trim() : '';
    return text || fallback;
}

export function normalizeProjectContentPublishTarget(value): ProjectContentPublishTarget | undefined {
    if (value === undefined || value === null)
        return undefined;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw projectArchitectureError('contentPublishTarget must be an object when provided.');
    }
    const kind = normalizeProjectPath(value.kind, '');
    if (!CONTENT_PUBLISH_TARGETS.has(kind)) {
        throw projectArchitectureError(`Unsupported content publish target: ${kind || String(value.kind)}.`);
    }
    const target: ProjectContentPublishTarget = { kind };
    if (typeof value.bucket === 'string' && value.bucket.trim())
        target.bucket = value.bucket.trim();
    if (typeof value.prefix === 'string' && value.prefix.trim())
        target.prefix = value.prefix.trim();
    if (typeof value.manifestPath === 'string' && value.manifestPath.trim())
        target.manifestPath = value.manifestPath.trim();
    if (value.metadata && typeof value.metadata === 'object' && !Array.isArray(value.metadata))
        target.metadata = value.metadata;
    return target;
}

export function normalizeProjectArchitecture(input): ProjectArchitecture {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw projectArchitectureError('Project architecture must be an object.');
    }
    if (input.repositoryTopology !== undefined
        || input.contentRoot !== undefined
        || input.metadata?.repositoryTopology !== undefined
        || input.metadata?.contentRoot !== undefined
        || input.metadata?.sitePath !== undefined
        || input.metadata?.contentPath !== undefined) {
        throw projectArchitectureError('Project topology must be declared as canonical architecture, not legacy metadata.', 'legacy_project_topology_rejected');
    }
    if (containsPlaintextSecretMaterial(input)) {
        throw projectArchitectureError('Project architecture cannot contain plaintext credentials, tokens, or secret material.', 'project_architecture_secret_material_rejected');
    }
    const topology = normalizeProjectPath(input.topology, '');
    if (LEGACY_PROJECT_TOPOLOGIES.has(topology)) {
        throw projectArchitectureError(`Unsupported legacy project topology: ${topology}.`, 'legacy_project_topology_rejected');
    }
    if (!PROJECT_ARCHITECTURE_TOPOLOGIES.has(topology)) {
        throw projectArchitectureError(`Unsupported project topology: ${topology || String(input.topology)}.`);
    }
    const contentRuntimeSource = normalizeProjectPath(input.contentRuntimeSource, '');
    if (!CONTENT_RUNTIME_SOURCES.has(contentRuntimeSource)) {
        throw projectArchitectureError(`Unsupported content runtime source: ${contentRuntimeSource || String(input.contentRuntimeSource)}.`);
    }
    const localContentMaterialization = normalizeProjectPath(input.localContentMaterialization, '');
    if (!LOCAL_CONTENT_MATERIALIZATIONS.has(localContentMaterialization)) {
        throw projectArchitectureError(`Unsupported local content materialization: ${localContentMaterialization || String(input.localContentMaterialization)}.`);
    }
    const sitePath = normalizeProjectPath(input.sitePath, '');
    if (!sitePath) {
        throw projectArchitectureError('Project architecture requires sitePath.');
    }
    const architecture: ProjectArchitecture = {
        topology,
        rootPath: normalizeProjectPath(input.rootPath, '.'),
        sitePath,
        contentPath: normalizeProjectPath(input.contentPath, ''),
        contentRuntimeSource,
        localContentMaterialization,
    };
    if (!architecture.contentPath)
        delete architecture.contentPath;
    const contentPublishTarget = normalizeProjectContentPublishTarget(input.contentPublishTarget);
    if (contentPublishTarget)
        architecture.contentPublishTarget = contentPublishTarget;
    if (typeof input.requiresLocalContentForCi === 'boolean')
        architecture.requiresLocalContentForCi = input.requiresLocalContentForCi;
    if (typeof input.requiresLocalContentForDeploy === 'boolean')
        architecture.requiresLocalContentForDeploy = input.requiresLocalContentForDeploy;
    if (architecture.topology === 'split_site_content' && architecture.contentRuntimeSource === 'local_directory' && !architecture.contentPath) {
        throw projectArchitectureError('split_site_content projects using local_directory content must declare contentPath.');
    }
    if (!architecture.requiresLocalContentForCi
        && !architecture.requiresLocalContentForDeploy
        && architecture.contentRuntimeSource !== 'local_directory'
        && ['managed_clone', 'submodule'].includes(architecture.localContentMaterialization)) {
        throw projectArchitectureError('CI/deploy defaults must not require managed_clone or submodule content unless explicitly requested.');
    }
    if (architecture.contentPublishTarget?.kind === 'cloudflare_r2' && architecture.contentRuntimeSource === 'local_directory' && !architecture.contentPath) {
        throw projectArchitectureError('Cloudflare R2 content publish targets need a contentPath when runtime source is local_directory.');
    }
    return architecture;
}

export function projectArchitectureContentSource(architecture) {
    if (!architecture)
        return null;
    if (architecture.contentRuntimeSource === 'treedx_snapshot')
        return 'treedx';
    if (architecture.contentRuntimeSource === 'r2_published_manifest' || architecture.contentRuntimeSource === 'r2_preview_overlay')
        return 'r2_published_artifacts';
    return 'local_directory';
}

export function projectDeletionConfirmationMatches(value, projectSlug) {
    return String(value ?? '') === `${TEAM_DELETION_CONFIRMATION_PREFIX}${String(projectSlug ?? '').trim().toLowerCase()}`;
}

export function normalizeProjectSlug(value) {
    return String(value ?? '').trim().toLowerCase();
}

export function validateProjectSlug(value) {
    const slug = normalizeProjectSlug(value);
    if (!slug) {
        return { ok: false, code: 'missing', message: 'Project slug is required.' };
    }
    if (slug.length > 80
        || !/^[a-z0-9-]+$/u.test(slug)
        || slug.startsWith('-')
        || slug.endsWith('-')
        || slug.includes('--')) {
        return {
            ok: false,
            code: 'format',
            message: 'Project slugs can use 1-80 letters, numbers, or single hyphens, with no leading or trailing hyphen.',
        };
    }
    return { ok: true, slug };
}

export function serializeProject(row) {
    if (!row)
        return null;
    return {
        id: row.id,
        teamId: row.team_id,
        slug: row.slug,
        name: row.name,
        description: row.description,
        metadata: parseJson(row.metadata_json, {}),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

export function summarizeProjectHealth({ hosting, connection, deployments, jobs }) {
    const failedDeployment = deployments.find((deployment) => deployment.status === 'failed');
    if (failedDeployment) {
        return {
            state: 'verification_failing',
            label: 'Verification failing',
            reason: `Latest ${failedDeployment.environment} deployment failed.`,
        };
    }
    const failedJob = jobs.find((job) => job.status === 'failed');
    if (failedJob) {
        return {
            state: 'action_required',
            label: 'Action required',
            reason: `Workflow ${failedJob.operation} failed.`,
        };
    }
    if (!hosting || !connection) {
        return {
            state: 'setup_needed',
            label: 'Setup needed',
            reason: 'Hosting and runtime connection still need configuration.',
        };
    }
    const readyRelease = deployments.find((deployment) => deployment.environment === 'staging' && deployment.status === 'succeeded');
    if (readyRelease) {
        return {
            state: 'release_ready',
            label: 'Release ready',
            reason: 'A verified staging candidate is ready for human review.',
        };
    }
    return {
        state: 'working_normally',
        label: 'Working normally',
        reason: 'This project has a healthy runtime surface and no active failures.',
    };
}

export function serializeProjectUpdatePlan(row) {
    if (!row)
        return null;
    return {
        id: row.id,
        hubId: row.hub_id,
        teamId: row.team_id,
        sourceKind: row.source_kind,
        sourceRef: row.source_ref,
        sourceVersion: row.source_version,
        plan: parseJson(row.plan_json, {}),
        state: row.state,
        requiresDecision: Boolean(row.requires_decision),
        decisionId: row.decision_id,
        createdBy: row.created_by,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

export function serializeProjectEnvironment(row) {
    if (!row)
        return null;
    return {
        id: row.id,
        projectId: row.project_id,
        environment: row.environment,
        deploymentProfile: row.deployment_profile,
        baseUrl: row.base_url,
        cloudflareAccountId: row.cloudflare_account_id,
        pagesProjectName: row.pages_project_name,
        workerName: row.worker_name,
        r2BucketName: row.r2_bucket_name,
        d1DatabaseName: row.d1_database_name,
        railwayProjectName: row.railway_project_name,
        metadata: parseJson(row.metadata_json, {}),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

export function serializeProjectSummarySnapshot(row) {
    if (!row)
        return null;
    return {
        projectId: row.project_id,
        teamId: row.team_id,
        summary: parseJson(row.summary_json, {}),
        generatedAt: row.generated_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}
