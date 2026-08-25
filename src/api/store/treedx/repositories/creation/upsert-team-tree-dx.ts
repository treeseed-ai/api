import { randomUUID } from 'node:crypto';
import { isoNow,ControlPlaneStore,objectValue,serializeTreeDxInstance } from "../../../../persistence/store.ts";
export async function upsertTeamTreeDxMethod(this: ControlPlaneStore, teamId, input: any = {}) {
    await this.ensureInitialized();
    const timestamp = isoNow();
    const existing = await this.getPrimaryTreeDxInstance(teamId);
    const id = input.id ?? existing?.id ?? randomUUID();
    const kind = String(input.kind ?? existing?.kind ?? (input.publicRead ? 'managed_public_federation' : 'managed_private'));
    const provider = String(input.provider ?? existing?.provider ?? (kind === 'managed_public_federation' ? 'public_federation' : kind === 'self_hosted' ? 'self_hosted' : 'railway'));
    const status = String(input.status ?? existing?.status ?? (input.baseUrl ? 'active' : 'pending'));
    if (status === 'active') {
        await this.run(`UPDATE treedx_instances SET status = 'disabled', updated_at = ? WHERE team_id = ? AND COALESCE("primary", 1) != 0 AND id != ? AND status = 'active'`, [timestamp, teamId, id]);
    }
    await this.run(`INSERT INTO treedx_instances (
				id, team_id, kind, provider, name, base_url, registry_url, public_read, "primary", status, image_ref,
				railway_project_id, railway_service_id, railway_environment_id, volume_mount_path, metadata_json, created_at, updated_at
			) VALUES (
				?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
			)
			ON CONFLICT (id) DO UPDATE SET
				kind = EXCLUDED.kind,
				provider = EXCLUDED.provider,
				name = EXCLUDED.name,
				base_url = EXCLUDED.base_url,
				registry_url = EXCLUDED.registry_url,
				public_read = EXCLUDED.public_read,
				"primary" = EXCLUDED."primary",
				status = EXCLUDED.status,
				image_ref = EXCLUDED.image_ref,
				railway_project_id = EXCLUDED.railway_project_id,
				railway_service_id = EXCLUDED.railway_service_id,
				railway_environment_id = EXCLUDED.railway_environment_id,
				volume_mount_path = EXCLUDED.volume_mount_path,
				metadata_json = EXCLUDED.metadata_json,
				updated_at = EXCLUDED.updated_at`, [
        id,
        teamId,
        kind,
        provider,
        String(input.name ?? existing?.name ?? 'TreeDX Knowledge Library'),
        input.baseUrl ?? existing?.baseUrl ?? null,
        input.registryUrl ?? input.baseUrl ?? existing?.registryUrl ?? null,
        input.publicRead === undefined ? Number(existing?.publicRead ?? false) : Number(Boolean(input.publicRead)),
        1,
        status,
        input.imageRef ?? existing?.imageRef ?? 'treeseed/treedx:latest',
        input.railwayProjectId ?? existing?.railwayProjectId ?? null,
        input.railwayServiceId ?? existing?.railwayServiceId ?? null,
        input.railwayEnvironmentId ?? existing?.railwayEnvironmentId ?? null,
        input.volumeMountPath ?? existing?.volumeMountPath ?? (provider === 'railway' ? '/data' : null),
        JSON.stringify({
            ...(existing?.metadata ?? {}),
            ...(objectValue(input.metadata, {}) ?? {}),
            hostRole: 'knowledge-library',
            contentCanonical: 'treedx',
        }),
        existing?.createdAt ?? timestamp,
        timestamp,
    ]);
    return serializeTreeDxInstance(await this.first(`SELECT * FROM treedx_instances WHERE team_id = ? AND id = ? LIMIT 1`, [teamId, id])) ?? {
        id,
        teamId,
        kind,
        provider,
        name: String(input.name ?? existing?.name ?? 'TreeDX Knowledge Library'),
        baseUrl: input.baseUrl ?? existing?.baseUrl ?? null,
        registryUrl: input.registryUrl ?? input.baseUrl ?? existing?.registryUrl ?? null,
        publicRead: input.publicRead === undefined ? Boolean(existing?.publicRead ?? false) : Boolean(input.publicRead),
        primary: true,
        status,
        imageRef: input.imageRef ?? existing?.imageRef ?? 'treeseed/treedx:latest',
        railwayProjectId: input.railwayProjectId ?? existing?.railwayProjectId ?? null,
        railwayServiceId: input.railwayServiceId ?? existing?.railwayServiceId ?? null,
        railwayEnvironmentId: input.railwayEnvironmentId ?? existing?.railwayEnvironmentId ?? null,
        volumeMountPath: input.volumeMountPath ?? existing?.volumeMountPath ?? (provider === 'railway' ? '/data' : null),
        metadata: {
            ...(existing?.metadata ?? {}),
            ...(objectValue(input.metadata, {}) ?? {}),
            hostRole: 'knowledge-library',
            contentCanonical: 'treedx',
        },
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
    };
}
