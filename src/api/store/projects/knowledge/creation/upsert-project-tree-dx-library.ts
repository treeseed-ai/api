import { randomUUID } from 'node:crypto';
import { isoNow,MarketControlPlaneStore,objectValue,serializeTreeDxInstance } from "../../../../persistence/store.ts";

export function mergeRepositoryTopologyMetadata(existing: unknown, requested: unknown) {
    const current = objectValue(existing, {});
    const update = objectValue(requested, {});
    const mergePlane = (name: 'contentRepository' | 'siteRepository' | 'projectRepository') => ({
        ...objectValue(current[name], {}),
        ...objectValue(update[name], {}),
    });
    return {
        ...current,
        ...update,
        contentRepository: mergePlane('contentRepository'),
        siteRepository: mergePlane('siteRepository'),
        projectRepository: mergePlane('projectRepository'),
    };
}

export async function upsertProjectTreeDxLibraryMethod(this: MarketControlPlaneStore, projectId, input: any = {}) {
    await this.ensureInitialized();
    const project = await this.getProject(projectId);
    if (!project)
        return null;
    const instance = input.instanceId
        ? serializeTreeDxInstance(await this.first(`SELECT * FROM treedx_instances WHERE id = ? LIMIT 1`, [input.instanceId]))
        : await this.getPrimaryTreeDxInstance(project.teamId);
    if (!instance || instance.teamId !== project.teamId)
        return null;
    const existing = await this.getProjectTreeDxLibrary(projectId);
    const repositories = await this.listHubRepositories(projectId);
    const contentRepository = repositories.find((entry) => entry.role === 'content') ?? null;
    const softwareRepository = repositories.find((entry) => ['software', 'primary', 'package'].includes(entry.role)) ?? repositories[0] ?? null;
    const timestamp = isoNow();
    const id = input.id ?? existing?.id ?? randomUUID();
    const libraryId = String(input.libraryId ?? existing?.libraryId ?? `${project.teamId}/${project.slug}`);
	const contentPath = String(input.contentPath ?? existing?.contentPath ?? '').trim().replace(/^\/+|\/+$/gu, '');
	if (!contentPath)
		throw new Error(`Project ${project.slug} requires a configured content path before TreeDX can be bound.`);
    const topology = this.buildRepositoryTopologySnapshot({
        project,
        instance,
        binding: {
            libraryId,
            repositoryId: input.repositoryId ?? existing?.repositoryId ?? null,
            contentPath,
            contentRepositoryUrl: input.contentRepositoryUrl ?? existing?.contentRepositoryUrl ?? contentRepository?.url ?? null,
            contentRepositoryDefaultBranch: input.contentRepositoryDefaultBranch ?? existing?.contentRepositoryDefaultBranch ?? contentRepository?.defaultBranch ?? null,
            contentRepositoryRef: input.contentRepositoryRef ?? existing?.contentRepositoryRef ?? contentRepository?.currentBranch ?? null,
            r2BucketName: input.r2BucketName ?? existing?.r2BucketName ?? null,
            r2ManifestKey: input.r2ManifestKey ?? existing?.r2ManifestKey ?? null,
        },
        softwareRepository,
        workspaceLink: null,
        metadata: mergeRepositoryTopologyMetadata(existing?.topology, input.topology),
    });
    if (existing) {
        await this.run(`UPDATE treedx_project_libraries
				 SET instance_id = ?, library_id = ?, repository_id = ?, content_path = ?, content_repository_url = ?,
				     content_repository_default_branch = ?, content_repository_ref = ?, r2_bucket_name = ?, r2_manifest_key = ?,
				     topology_json = ?, metadata_json = ?, updated_at = ?
				 WHERE project_id = ?`, [
            instance.id,
            libraryId,
            input.repositoryId ?? existing.repositoryId ?? null,
            contentPath,
            input.contentRepositoryUrl ?? existing.contentRepositoryUrl ?? contentRepository?.url ?? null,
            input.contentRepositoryDefaultBranch ?? existing.contentRepositoryDefaultBranch ?? contentRepository?.defaultBranch ?? null,
            input.contentRepositoryRef ?? existing.contentRepositoryRef ?? contentRepository?.currentBranch ?? null,
            input.r2BucketName ?? existing.r2BucketName ?? null,
            input.r2ManifestKey ?? existing.r2ManifestKey ?? null,
            JSON.stringify(topology),
            JSON.stringify({ ...(existing.metadata ?? {}), ...(objectValue(input.metadata, {}) ?? {}) }),
            timestamp,
            projectId,
        ]);
    }
    else {
        await this.run(`INSERT INTO treedx_project_libraries (
					id, team_id, project_id, instance_id, library_id, repository_id, content_path, content_repository_url,
					content_repository_default_branch, content_repository_ref, r2_bucket_name, r2_manifest_key,
					topology_json, metadata_json, created_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
            id,
            project.teamId,
            projectId,
            instance.id,
            libraryId,
            input.repositoryId ?? null,
            contentPath,
            input.contentRepositoryUrl ?? contentRepository?.url ?? null,
            input.contentRepositoryDefaultBranch ?? contentRepository?.defaultBranch ?? null,
            input.contentRepositoryRef ?? contentRepository?.currentBranch ?? null,
            input.r2BucketName ?? null,
            input.r2ManifestKey ?? null,
            JSON.stringify(topology),
            JSON.stringify(objectValue(input.metadata, {})),
            timestamp,
            timestamp,
        ]);
    }
    await this.ensureHubContentSourceTreeDx(projectId, project.teamId, contentRepository?.id ?? null, topology);
    return this.getProjectTreeDxLibrary(projectId);
}
