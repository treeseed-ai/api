import { mergeSeedMetadata } from '../index.js';

export async function applyAction({ action, store, ids, manifestHash, appliedAt, plan }) {
    if (action.action === 'skip' || action.action === 'unchanged')
        return null;
    const metadata = mergeSeedMetadata(action.existing?.metadata, action.payload.metadata, action, manifestHash, appliedAt);
    if (action.kind === 'team') {
        const existing = action.existing;
        const team = existing
            ? (await store.updateTeamSettings(existing.id, {
                name: action.payload.name,
                displayName: action.payload.displayName,
                logoUrl: action.payload.logoUrl,
                profileSummary: action.payload.profileSummary,
                metadata,
            })).ok === false ? existing : await store.getTeam(existing.id)
            : await store.createTeam({
                slug: action.payload.slug,
                name: action.payload.name,
                displayName: action.payload.displayName,
                logoUrl: action.payload.logoUrl,
                profileSummary: action.payload.profileSummary,
                metadata,
            });
        ids.teams.set(action.key, team.id);
        return team;
    }
    if (action.kind === 'repositoryHost') {
        const teamId = ids.teams.get(action.payload.teamKey);
        if (!teamId)
            throw new Error(`Missing team for ${action.key}.`);
        const host = await store.upsertRepositoryHost(teamId, {
            id: action.existing?.id,
            teamId,
            provider: action.payload.provider,
            ownership: action.payload.ownership ?? 'treeseed_managed',
            name: action.payload.name,
            accountLabel: action.payload.accountLabel,
            organizationOrOwner: action.payload.organizationOrOwner,
            defaultVisibility: action.payload.defaultVisibility ?? 'private',
            softwareRepositoryNameTemplate: action.payload.softwareRepositoryNameTemplate,
            contentRepositoryNameTemplate: action.payload.contentRepositoryNameTemplate,
            branchPolicy: action.payload.branchPolicy ?? {},
            workflowPolicy: action.payload.workflowPolicy ?? {},
            allowedProjectKinds: action.payload.allowedProjectKinds ?? [],
            status: action.payload.status ?? 'active',
            metadata: {
                ...metadata,
                ...(action.payload.credentialRef ? { credentialRef: action.payload.credentialRef } : {}),
            },
        });
        ids.repositoryHosts.set(action.key, host.id);
        return host;
    }
    if (action.kind === 'project') {
        const teamId = ids.teams.get(action.payload.teamKey);
        if (!teamId)
            throw new Error(`Missing team for ${action.key}.`);
        const projectMetadata = {
            metadata,
            kind: action.payload.kind,
            repository: action.payload.repository,
            architecture: action.payload.architecture,
        };
        const project = action.existing
            ? await store.updateProject(action.existing.id, {
                slug: action.payload.slug,
                name: action.payload.name,
                description: action.payload.description,
                metadata: projectMetadata,
            })
            : (await store.createProject(teamId, {
                slug: action.payload.slug,
                name: action.payload.name,
                description: action.payload.description,
                metadata: projectMetadata,
            })).project;
        ids.projects.set(action.key, project.id);
        return project;
    }
    if (action.kind === 'hubRepository') {
        const projectId = ids.projects.get(action.payload.projectKey);
        if (!projectId)
            throw new Error(`Missing project for ${action.key}.`);
        const projectAction = plan.actions.find((entry) => entry.key === action.payload.projectKey);
        const teamId = projectAction ? ids.teams.get(projectAction.payload.teamKey) : null;
        if (!teamId)
            throw new Error(`Missing team for ${action.key}.`);
        const repository = await store.upsertHubRepository(projectId, {
            id: action.existing?.id,
            teamId,
            role: action.payload.role,
            repositoryHostId: action.payload.repositoryHostKey ? ids.repositoryHosts.get(action.payload.repositoryHostKey) ?? null : null,
            provider: action.payload.provider,
            owner: action.payload.owner,
            name: action.payload.name,
            url: action.payload.gitUrl,
            defaultBranch: action.payload.defaultBranch ?? 'main',
            currentBranch: action.payload.currentBranch ?? action.payload.defaultBranch ?? 'main',
            status: action.payload.status ?? 'active',
            accessPolicy: action.payload.accessPolicy ?? {},
            releasePolicy: action.payload.releasePolicy ?? {},
            publishPolicy: action.payload.publishPolicy ?? {},
            submodulePath: action.payload.submodulePath ?? null,
            metadata,
        });
        return repository;
    }
    if (action.kind === 'product') {
        const teamId = ids.teams.get(action.payload.teamKey);
        if (!teamId)
            throw new Error(`Missing team for ${action.key}.`);
        const product = await store.upsertCatalogItem(teamId, {
            id: action.existing?.id,
            kind: action.payload.kind,
            slug: action.payload.slug,
            title: action.payload.title,
            summary: action.payload.summary,
            visibility: action.payload.visibility ?? 'private',
            listingEnabled: action.payload.listingEnabled === true,
            offerMode: action.payload.offerMode ?? 'private',
            manifestKey: action.payload.manifestKey,
            artifactKey: action.payload.artifactKey,
            searchText: action.payload.searchText,
            metadata,
        });
        ids.products.set(action.key, product.id);
        ids.productTeams.set(action.key, teamId);
        return product;
    }
    if (action.kind === 'catalogArtifact') {
        const productId = ids.products.get(action.payload.productKey);
        const teamId = ids.productTeams.get(action.payload.productKey);
        if (!teamId || !productId)
            throw new Error(`Missing product for ${action.key}.`);
        return store.upsertCatalogArtifactVersion(teamId, productId, {
            id: action.existing?.id,
            version: action.payload.version,
            kind: action.payload.kind,
            contentKey: action.payload.contentKey,
            manifestKey: action.payload.manifestKey,
            publishedAt: action.payload.publishedAt,
            metadata,
        });
    }
    return null;
}
