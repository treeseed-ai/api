import { redactSensitiveValue } from '../../../../../security/redact-sensitive-value.ts';
import { getNodeBuiltin,parseJson } from '../../index.ts';

export function artifactStorageRoot(config) {
    const path = getNodeBuiltin('path');
    if (!path)
        return null;
    const root = String(config.agentArtifactStorageRoot ?? config.repoRoot ?? process.cwd()).trim();
    return path.resolve(root, '.treeseed/generated/hosted-artifacts');
}

export function serializeSeedRun(row) {
    if (!row)
        return null;
    return {
        id: row.id,
        seedName: row.seed_name,
        seedVersion: Number(row.seed_version ?? 1),
        environments: parseJson(row.environments_json, []),
        mode: row.mode,
        state: row.state,
        actorType: row.actor_type,
        actorId: row.actor_id,
        manifestHash: row.manifest_hash,
        plan: redactSensitiveValue(parseJson(row.plan_json, null)),
        result: redactSensitiveValue(parseJson(row.result_json, null)),
        error: redactSensitiveValue(parseJson(row.error_json, null)),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        completedAt: row.completed_at,
    };
}

export function serializeCatalogItem(row) {
    if (!row)
        return null;
    return {
        id: row.id,
        teamId: row.team_id,
        kind: row.kind,
        slug: row.slug,
        title: row.title,
        summary: row.summary,
        visibility: row.visibility,
        listingEnabled: Boolean(row.listing_enabled),
        offerMode: row.offer_mode,
        manifestKey: row.manifest_key,
        artifactKey: row.artifact_key,
        searchText: row.search_text,
        metadata: parseJson(row.metadata_json, {}),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

export function serializeCatalogArtifactVersion(row) {
    if (!row)
        return null;
    return {
        id: row.id,
        itemId: row.item_id,
        teamId: row.team_id,
        kind: row.kind,
        version: row.version,
        contentKey: row.content_key,
        manifestKey: row.manifest_key,
        metadata: parseJson(row.metadata_json, {}),
        publishedAt: row.published_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}
