import { ControlPlaneStore } from "../../../../../persistence/store.ts";
export async function resolveGovernancePolicyMethod(this: ControlPlaneStore, input: any = {}) {
    if (input.projectId) {
        const projectPolicy = await this.getProjectGovernancePolicy(input.projectId);
        if (projectPolicy)
            return projectPolicy;
    }
    return this.getTeamGovernancePolicy(input.teamId, input.scope === 'commons' ? 'commons' : 'team');
}
