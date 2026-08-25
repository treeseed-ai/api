import { ControlPlaneStore,serializeGovernancePolicy } from "../../../../persistence/store.ts";
export async function getProjectGovernancePolicyMethod(this: ControlPlaneStore, projectId) {
    await this.ensureInitialized();
    const row = await this.first(`SELECT * FROM project_governance_policies
			 WHERE project_id = ? AND active = 1
			 ORDER BY updated_at DESC LIMIT 1`, [projectId]);
    if (row)
        return serializeGovernancePolicy(row);
    const project = await this.getProject(projectId);
    if (!project)
        return null;
    return this.getTeamGovernancePolicy(project.teamId, 'project_default');
}
