import { randomUUID } from 'node:crypto';
import { isoNow,MarketControlPlaneStore,normalizeProjectArchitecture,validateProjectSlug } from "../../../../persistence/store.ts";
export async function createProjectMethod(this: MarketControlPlaneStore, teamId, input) {
    await this.ensureInitialized();
    const timestamp = isoNow();
    const id = input.id ?? randomUUID();
    const slugResult = validateProjectSlug(input.slug);
    if (!slugResult.ok) {
        throw new Error(slugResult.message);
    }
    const existing = await this.getProjectByTeamAndSlug(teamId, slugResult.slug);
    if (existing) {
        throw new Error('That project slug is already in use for this team.');
    }
    await this.run(`INSERT INTO projects (id, team_id, slug, name, description, metadata_json, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [
        id,
        teamId,
        slugResult.slug,
        input.name,
        input.description ?? null,
        JSON.stringify(input.metadata ?? {}),
        timestamp,
        timestamp,
    ]);
    await this.run(`INSERT INTO entitlements (id, team_id, project_id, tier, status, metadata_json, created_at, updated_at)
			 VALUES (?, ?, ?, ?, 'active', ?, ?, ?)`, [
        randomUUID(),
        teamId,
        id,
        input.entitlementTier ?? 'free',
        JSON.stringify({ seededBy: 'market_control_plane' }),
        timestamp,
        timestamp,
    ]);
    await this.upsertCatalogItem(teamId, {
        id,
        kind: 'project',
        slug: slugResult.slug,
        title: input.name,
        summary: input.description ?? null,
        visibility: 'team',
        listingEnabled: input.metadata?.listingEnabled === true,
        offerMode: input.entitlementTier ?? 'free',
        manifestKey: input.metadata?.manifestKey ?? null,
        artifactKey: input.metadata?.artifactKey ?? null,
        searchText: [input.name, input.description].filter(Boolean).join(' ').trim() || null,
        metadata: input.metadata ?? {},
    });
    if (input.metadata?.architecture) {
        await this.projectArchitectureContentBindings(id, normalizeProjectArchitecture(input.metadata.architecture)).catch(() => null);
    }
    return this.getProjectDetails(id);
}
