import { governanceVotingProvider } from '@treeseed/sdk';
import { isoNow,MarketControlPlaneStore,objectValue,optionalStringValue,serializeGovernancePolicy } from "../../../../persistence/store.ts";
export async function setProjectGovernancePolicyMethod(this: MarketControlPlaneStore, projectId, input: any = {}) {
    await this.ensureInitialized();
    const project = await this.getProject(projectId);
    if (!project)
        return null;
    const provider = governanceVotingProvider(optionalStringValue(input.providerId, 'admin_approval_v1'));
    const timestamp = isoNow();
    await this.run(`UPDATE project_governance_policies SET active = 0, superseded_at = ?, updated_at = ?
			 WHERE project_id = ? AND active = 1`, [timestamp, timestamp, projectId]);
    const id = input.id ?? `governance-policy:${projectId}:${Date.parse(timestamp)}`;
    await this.run(`INSERT INTO project_governance_policies (
				id, team_id, project_id, provider_id, provider_version, config_json, active, created_by, created_at, updated_at, superseded_at
			) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, NULL)`, [id, project.teamId, project.id, provider.id, provider.version, JSON.stringify(objectValue(input.config, {})), input.createdBy ?? null, timestamp, timestamp]);
    return serializeGovernancePolicy(await this.first(`SELECT * FROM project_governance_policies WHERE id = ? LIMIT 1`, [id]));
}
