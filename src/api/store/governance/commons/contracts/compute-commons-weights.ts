import { COMMONS_DELEGATED_WEIGHT_CAP,COMMONS_TOTAL_WEIGHT_CAP,ControlPlaneStore,numberValue,objectValue } from "../../../../persistence/store.ts";
export function computeCommonsWeightsMethod(this: ControlPlaneStore, { verifiedEmail = false, participant = null, principal = null }: any = {}) {
    const metadata = objectValue(principal?.metadata, {});
    const baseWeight = 1;
    const verifiedEmailWeight = verifiedEmail ? 0.25 : 0;
    const trustRoleWeight = Array.isArray(principal?.roles) && principal.roles.some((role) => ['platform_admin', 'platform_admin'].includes(role)) ? 0.5 : 0;
    const contributionWeight = Math.min(1, numberValue(metadata.commonsContributionWeight, numberValue(participant?.contribution_weight, 0)) ?? 0);
    const stakeholderWeight = Math.min(1, numberValue(metadata.commonsStakeholderWeight, numberValue(participant?.stakeholder_weight, 0)) ?? 0);
    const delegatedWeight = Math.min(COMMONS_DELEGATED_WEIGHT_CAP, numberValue(participant?.delegated_weight, 0) ?? 0);
    const totalWeight = Math.min(COMMONS_TOTAL_WEIGHT_CAP, baseWeight + verifiedEmailWeight + trustRoleWeight + contributionWeight + stakeholderWeight + delegatedWeight);
    return { baseWeight, verifiedEmailWeight, accountAgeWeight: 0, trustRoleWeight, trustWeight: trustRoleWeight, contributionWeight, stakeholderWeight, delegatedWeight, totalWeight };
}
