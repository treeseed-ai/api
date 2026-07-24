import YAML from 'yaml';
import { createLocalSeedStore, slugKey, generatedKey, seededKey, exportMetadata, maybeAssign, pruneNullish, sortBy, normalizeExportEnvironments } from './index.js';

export async function exportSeedWithStore(input) {
    const diagnostics = [];
    const team = input.teamId
        ? await input.store.getTeam(input.teamId)
        : input.team
            ? await input.store.getTeamBySlug(input.team) ?? await input.store.getTeamByName(input.team)
            : null;
    if (!team) {
        return {
            ok: false,
            seed: input.name,
            manifest: null,
            yaml: '',
            diagnostics: [{
                    severity: 'error',
                    code: 'seed.export_team_missing',
                    message: 'Team was not found for seed export.',
                    path: 'team',
                }],
        };
    }
    const environments = normalizeExportEnvironments(input.environments);
    const teamKey = seededKey(team.metadata, generatedKey('team', team.slug ?? team.name));
    const manifest = {
        name: input.name ?? slugKey(team.slug ?? team.name),
        version: 1,
        description: `${team.displayName ?? team.name} exported seed bundle.`,
        defaultEnvironments: environments.includes('local') ? ['local'] : [environments[0]],
        environments,
        resources: {
            teams: [{
                    key: teamKey,
                    slug: team.slug,
                    name: team.name,
                    displayName: team.displayName,
                    ...(team.logoUrl ? { logoUrl: team.logoUrl } : {}),
                    ...(team.profileSummary ? { profileSummary: team.profileSummary } : {}),
                    ...(exportMetadata(team.metadata) ? { metadata: exportMetadata(team.metadata) } : {}),
                }],
            repositoryHosts: [],
            projects: [],
            hubRepositories: [],
            products: [],
            catalogArtifacts: [],
        },
    };
    const repositoryHostKeyById = new Map();
    for (const host of (await input.store.listRepositoryHosts(team.id, { includePlatform: false })).sort(sortBy((host) => host.provider, (host) => host.name))) {
        const key = seededKey(host.metadata, generatedKey('repository-host', team.slug, host.provider, host.name));
        repositoryHostKeyById.set(host.id, key);
        const resource: Record<string, unknown> = {
            key,
            team: teamKey,
            provider: host.provider,
            name: host.name,
            ownership: host.ownership,
            organizationOrOwner: host.organizationOrOwner,
            defaultVisibility: host.defaultVisibility,
            status: host.status,
        };
        maybeAssign(resource, 'accountLabel', host.accountLabel);
        maybeAssign(resource, 'softwareRepositoryNameTemplate', host.softwareRepositoryNameTemplate);
        maybeAssign(resource, 'contentRepositoryNameTemplate', host.contentRepositoryNameTemplate);
        if (Object.keys(host.branchPolicy ?? {}).length > 0)
            resource.branchPolicy = host.branchPolicy;
        if (Object.keys(host.workflowPolicy ?? {}).length > 0)
            resource.workflowPolicy = host.workflowPolicy;
        if ((host.allowedProjectKinds ?? []).length > 0)
            resource.allowedProjectKinds = host.allowedProjectKinds;
        if (typeof host.metadata?.credentialRef === 'string')
            resource.credentialRef = host.metadata.credentialRef;
        const metadata = exportMetadata(host.metadata);
        if (metadata)
            resource.metadata = metadata;
        manifest.resources.repositoryHosts.push(resource);
    }
    const projects = (await input.store.listTeamProjects(team.id)).sort(sortBy((project) => project.slug));
    const projectKeyById = new Map();
    const chosenRepositoryRoleByProjectId = new Map();
    for (const project of projects) {
        const repositories = await input.store.listHubRepositories(project.id);
        const repository = repositories.find((entry) => ['primary', 'package', 'software', 'content'].includes(entry.role)) ?? repositories[0];
        if (!repository?.url) {
            diagnostics.push({ severity: 'warning', code: 'seed.export_project_without_repository', message: `Project ${project.slug} does not have a canonical repository URL and was skipped.`, path: `projects.${project.slug}` });
            continue;
        }
        const key = seededKey(project.metadata?.metadata, generatedKey('project', team.slug, project.slug));
        projectKeyById.set(project.id, key);
        chosenRepositoryRoleByProjectId.set(project.id, repository.role);
        const metadata = project.metadata?.metadata && typeof project.metadata.metadata === 'object' ? exportMetadata(project.metadata.metadata) : exportMetadata(project.metadata);
        const resource: Record<string, unknown> = {
            key,
            team: teamKey,
            slug: project.slug,
            name: project.name,
            description: project.description ?? undefined,
            kind: project.metadata?.kind ?? undefined,
            repository: {
                role: repository.role,
                provider: repository.provider,
                owner: repository.owner,
                name: repository.name,
                gitUrl: repository.url,
                defaultBranch: repository.defaultBranch ?? undefined,
                submodulePath: repository.submodulePath ?? undefined,
            },
            architecture: project.metadata?.architecture,
        };
        if (metadata)
            resource.metadata = metadata;
        manifest.resources.projects.push(resource);
    }
    for (const project of projects) {
        const projectKey = projectKeyById.get(project.id);
        if (!projectKey)
            continue;
        const repositories = (await input.store.listHubRepositories(project.id)).sort(sortBy((repository) => repository.role));
        for (const repository of repositories) {
            if (repository.role === chosenRepositoryRoleByProjectId.get(project.id))
                continue;
            const resource: Record<string, unknown> = {
                key: seededKey(repository.metadata, generatedKey('hub-repository', team.slug, project.slug, repository.role)),
                project: projectKey,
                role: repository.role,
                provider: repository.provider,
                owner: repository.owner,
                name: repository.name,
                gitUrl: repository.url,
                defaultBranch: repository.defaultBranch ?? undefined,
                currentBranch: repository.currentBranch ?? undefined,
                status: repository.status ?? undefined,
            };
            if (repository.repositoryHostId && repositoryHostKeyById.has(repository.repositoryHostId))
                resource.repositoryHost = repositoryHostKeyById.get(repository.repositoryHostId);
            maybeAssign(resource, 'submodulePath', repository.submodulePath);
            if (Object.keys(repository.accessPolicy ?? {}).length > 0)
                resource.accessPolicy = repository.accessPolicy;
            if (Object.keys(repository.releasePolicy ?? {}).length > 0)
                resource.releasePolicy = repository.releasePolicy;
            if (Object.keys(repository.publishPolicy ?? {}).length > 0)
                resource.publishPolicy = repository.publishPolicy;
            const metadata = exportMetadata(repository.metadata);
            if (metadata)
                resource.metadata = metadata;
            manifest.resources.hubRepositories.push(resource);
        }
    }
    const products = (await input.store.listTeamProducts(team.id, input.principal ?? null))
        .filter((product) => input.includePrivate === true || product.visibility === 'public')
        .sort(sortBy((product) => product.kind, (product) => product.slug));
    const productKeyById = new Map();
    for (const product of products) {
        const key = seededKey(product.metadata, generatedKey('product', team.slug, product.kind, product.slug));
        productKeyById.set(product.id, key);
        const resource: Record<string, unknown> = {
            key,
            team: teamKey,
            kind: product.kind,
            slug: product.slug,
            title: product.title,
            summary: product.summary ?? undefined,
            visibility: product.visibility,
            listingEnabled: product.listingEnabled,
            offerMode: product.offerMode,
            manifestKey: product.manifestKey ?? undefined,
            artifactKey: product.artifactKey ?? undefined,
            searchText: product.searchText ?? undefined,
        };
        const metadata = exportMetadata(product.metadata);
        if (metadata)
            resource.metadata = metadata;
        manifest.resources.products.push(resource);
    }
    if (input.includeArtifacts === true) {
        for (const product of products) {
            const productKey = productKeyById.get(product.id);
            if (!productKey)
                continue;
            for (const artifact of (await input.store.listCatalogArtifactVersions(product.id)).sort(sortBy((artifact) => artifact.version))) {
                const resource: Record<string, unknown> = {
                    key: seededKey(artifact.metadata, generatedKey('catalog-artifact', team.slug, product.slug, artifact.version)),
                    product: productKey,
                    version: artifact.version,
                    kind: artifact.kind,
                    contentKey: artifact.contentKey,
                    manifestKey: artifact.manifestKey ?? undefined,
                    publishedAt: artifact.publishedAt ?? undefined,
                };
                const metadata = exportMetadata(artifact.metadata);
                if (metadata)
                    resource.metadata = metadata;
                manifest.resources.catalogArtifacts.push(resource);
            }
        }
    }
    const cleanedManifest = pruneNullish(manifest);
    const yaml = YAML.stringify(cleanedManifest, { lineWidth: 0 });
    return {
        ok: diagnostics.every((diagnostic) => diagnostic.severity !== 'error'),
        seed: cleanedManifest.name,
        manifest: cleanedManifest,
        yaml,
        diagnostics,
    };
}

export async function exportSeedFromCli(input) {
    const store = input.store ?? await createLocalSeedStore(input.projectRoot, input.env);
    return exportSeedWithStore({
        ...input,
        store,
        name: input.seedName,
        team: input.team,
    });
}
