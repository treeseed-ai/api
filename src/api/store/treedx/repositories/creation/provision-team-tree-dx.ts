import { randomUUID } from 'node:crypto';
import { centralTreeDxRegistryUrl,isoNow,MarketControlPlaneStore,objectValue,teamIsPrivate } from "../../../../persistence/store.ts";
export async function provisionTeamTreeDxMethod(this: MarketControlPlaneStore, teamId, input: any = {}) {
    const team = await this.getTeam(teamId);
    if (!team)
        return null;
    const publicRead = input.publicRead ?? !teamIsPrivate(team);
    const registryUrl = input.registryUrl ?? centralTreeDxRegistryUrl(this.config);
    const trustTokenRef = input.trustTokenRef ?? `treedx-trust:${teamId}:central-public`;
    const existing = await this.getPrimaryTreeDxInstance(teamId);
    const status = input.status
        ?? (input.baseUrl || existing?.baseUrl ? 'active' : 'pending');
    const instance = await this.upsertTeamTreeDx(teamId, {
        ...input,
        kind: publicRead ? 'managed_public_federation' : 'managed_private',
        provider: 'railway',
        publicRead,
        name: input.name ?? (publicRead ? 'TreeSeed public federation' : `${team.slug} TreeDX`),
        registryUrl,
        status,
        imageRef: input.imageRef ?? 'treeseed/treedx:latest',
        volumeMountPath: '/data',
        metadata: {
            ...(objectValue(input.metadata, {}) ?? {}),
            deploymentScope: publicRead ? 'public_federation' : 'private_team',
            centralPublicRegistry: {
                url: registryUrl,
                trustMode: 'scoped_node_token',
                trustTokenRef,
                mirrorAllowed: !publicRead,
                queryDelegationAllowed: true,
            },
        },
    });
    const timestamp = isoNow();
    const deploymentId = randomUUID();
    await this.run(`INSERT INTO treedx_deployments (
				id, team_id, instance_id, provider, status, image_ref, volume_mount_path, service_refs_json, result_json, error_json, created_at, updated_at, completed_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
        deploymentId,
        teamId,
        instance.id,
        instance.provider,
        instance.baseUrl ? 'succeeded' : 'queued',
        instance.imageRef,
        instance.volumeMountPath,
        JSON.stringify({ railwayProjectId: instance.railwayProjectId, railwayServiceId: instance.railwayServiceId }),
        JSON.stringify({
            mode: instance.publicRead ? 'public_federation' : 'managed_private',
            nextAction: instance.publicRead
                ? 'Create or attach the shared public Railway TreeDX federation project, service, persistent /data volume, and public service domain.'
                : 'Create dedicated Railway project, service, persistent /data volume, and service token.',
            operation: 'queued_treedx_provision',
        }),
        null,
        timestamp,
        timestamp,
        instance.baseUrl ? timestamp : null,
    ]);
    let payload = await this.getTeamTreeDx(teamId);
    if (!publicRead) {
        const mirrors = payload.mirrors ?? await this.listTreeDxMirrors(teamId, instance.id);
        const hasCentralMirror = mirrors.some((mirror) => mirror.metadata?.centralPublicRegistry === true || mirror.targetUrl === registryUrl);
        if (!hasCentralMirror) {
            await this.createTreeDxMirror(teamId, {
                instanceId: instance.id,
                name: 'TreeSeed public registry mirror',
                direction: 'pull',
                targetKind: 'treedx',
                targetUrl: registryUrl,
                status: 'pending',
                instructions: 'Use the scoped TreeDX node trust token to mirror public templates, workflow imports, and knowledge packs from the central public registry.',
                metadata: {
                    centralPublicRegistry: true,
                    trustMode: 'scoped_node_token',
                    trustTokenRef,
                    privateDataEgress: 'deny_by_default',
                },
            });
            payload = await this.getTeamTreeDx(teamId);
        }
    }
    if (payload.instance)
        return payload;
    return {
        instance,
        mirrors: await this.listTreeDxMirrors(teamId, instance.id),
        shares: await this.listTreeDxShares(teamId),
        deployments: await this.listTreeDxDeployments(teamId, instance.id),
    };
}
