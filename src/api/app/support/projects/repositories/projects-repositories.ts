import { optionalTrimmedString } from '../../index.ts';
export function normalizeRepositorySlug(value) {
    const text = String(value ?? '').trim().toLowerCase();
    return text.includes('/') ? text : null;
}
export function resolvePlatformRepositoryDescriptor(config, details, body: any = {}) {
    const repositories = Array.isArray(details.repositories) ? details.repositories : [];
    const configured = body.repository && typeof body.repository === 'object' && !Array.isArray(body.repository) ? body.repository : {};
    const requestedRole = optionalTrimmedString(configured.role) ?? optionalTrimmedString(body.repositoryRole);
    const canonicalRepository = (requestedRole ? repositories.find((entry) => entry.role === requestedRole) : null)
        ?? repositories.find((entry) => ['primary', 'package', 'software', 'content'].includes(entry.role))
        ?? repositories[0]
        ?? null;
    const metadata = details.project?.metadata && typeof details.project.metadata === 'object' ? details.project.metadata : {};
    const metadataRepository = metadata.repository && typeof metadata.repository === 'object' ? metadata.repository : {};
    const cloneUrl = optionalTrimmedString(configured.cloneUrl)
        ?? optionalTrimmedString(canonicalRepository?.url)
        ?? optionalTrimmedString(metadataRepository.cloneUrl)
        ?? optionalTrimmedString(metadata.cloneUrl)
        ?? optionalTrimmedString(metadata.repositoryUrl)
        ?? optionalTrimmedString(config.repoRoot);
    return {
        provider: optionalTrimmedString(configured.provider)
            ?? optionalTrimmedString(canonicalRepository?.provider)
            ?? optionalTrimmedString(metadataRepository.provider)
            ?? 'local',
        owner: optionalTrimmedString(configured.owner)
            ?? optionalTrimmedString(canonicalRepository?.owner)
            ?? optionalTrimmedString(metadataRepository.owner)
            ?? optionalTrimmedString(metadata.repositoryOwner)
            ?? details.project.teamId,
        name: optionalTrimmedString(configured.name)
            ?? optionalTrimmedString(canonicalRepository?.name)
            ?? optionalTrimmedString(metadataRepository.name)
            ?? optionalTrimmedString(metadata.repositoryName)
            ?? details.project.slug,
        defaultBranch: optionalTrimmedString(configured.defaultBranch)
            ?? optionalTrimmedString(canonicalRepository?.defaultBranch)
            ?? optionalTrimmedString(metadataRepository.defaultBranch)
            ?? optionalTrimmedString(metadata.defaultBranch)
            ?? 'staging',
        cloneUrl,
        writeMode: ['workspace', 'branch', 'direct', 'pull_request'].includes(configured.writeMode)
            ? configured.writeMode
            : 'workspace',
        branchName: optionalTrimmedString(configured.branchName),
        push: configured.push === true,
        pathPolicies: Array.isArray(configured.pathPolicies)
            ? configured.pathPolicies
            : [{ allow: 'src/content/**' }],
    };
}
export function hubRepositoryPolicies(role) {
    if (role === 'content') {
        return {
            releasePolicy: {
                track: 'content_publish',
                softwareReleaseRequired: false,
                approvalRule: 'content_policy_approver',
            },
            publishPolicy: {
                track: 'content_publish',
                target: 'r2_published_artifacts',
                approvalRule: 'content_policy_approver',
            },
        };
    }
    if (role === 'parent_workspace') {
        return {
            releasePolicy: {
                track: 'parent_workspace_pointer',
                approvalRule: 'technical_steward',
            },
            publishPolicy: {
                disabled: true,
                reason: 'Parent workspace repositories are updated through workspace pointer jobs.',
            },
        };
    }
    return {
        releasePolicy: {
            track: 'software_release',
            approvalRule: 'technical_steward_or_release_approver',
        },
        publishPolicy: {
            disabled: true,
            reason: 'Software repositories do not publish content artifacts.',
        },
    };
}
