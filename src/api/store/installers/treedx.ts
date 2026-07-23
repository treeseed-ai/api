import type { MarketControlPlaneStore } from '../../store.ts';
import { getPrimaryTreeDxInstanceMethod } from '../get-primary-tree-dx-instance.ts';
import { getTeamTreeDxMethod } from '../get-team-tree-dx.ts';
import { upsertTeamTreeDxMethod } from '../upsert-team-tree-dx.ts';
import { provisionTeamTreeDxMethod } from '../provision-team-tree-dx.ts';
import { updateTreeDxDeploymentMethod } from '../update-tree-dx-deployment.ts';
import { listTreeDxDeploymentsMethod } from '../list-tree-dx-deployments.ts';
import { listTreeDxMirrorsMethod } from '../list-tree-dx-mirrors.ts';
import { createTreeDxMirrorMethod } from '../create-tree-dx-mirror.ts';
import { syncTreeDxMirrorMethod } from '../sync-tree-dx-mirror.ts';
import { listTreeDxSharesMethod } from '../list-tree-dx-shares.ts';
import { createTreeDxShareMethod } from '../create-tree-dx-share.ts';
import { upsertProjectTreeDxLibraryMethod } from '../upsert-project-tree-dx-library.ts';
import { getProjectTreeDxLibraryMethod } from '../get-project-tree-dx-library.ts';
import { ensureHubContentSourceTreeDxMethod } from '../ensure-hub-content-source-tree-dx.ts';
import { recordTreeDxCredentialIssuanceMethod } from '../record-tree-dx-credential-issuance.ts';
import { getTreeDxCredentialIssuanceRecordMethod } from '../get-tree-dx-credential-issuance-record.ts';
import { updateTreeDxCredentialIssuanceStatusMethod } from '../update-tree-dx-credential-issuance-status.ts';

export function installTreedxStoreMethods(prototype: MarketControlPlaneStore) {
	prototype.getPrimaryTreeDxInstance = getPrimaryTreeDxInstanceMethod;
	prototype.getTeamTreeDx = getTeamTreeDxMethod;
	prototype.upsertTeamTreeDx = upsertTeamTreeDxMethod;
	prototype.provisionTeamTreeDx = provisionTeamTreeDxMethod;
	prototype.updateTreeDxDeployment = updateTreeDxDeploymentMethod;
	prototype.listTreeDxDeployments = listTreeDxDeploymentsMethod;
	prototype.listTreeDxMirrors = listTreeDxMirrorsMethod;
	prototype.createTreeDxMirror = createTreeDxMirrorMethod;
	prototype.syncTreeDxMirror = syncTreeDxMirrorMethod;
	prototype.listTreeDxShares = listTreeDxSharesMethod;
	prototype.createTreeDxShare = createTreeDxShareMethod;
	prototype.upsertProjectTreeDxLibrary = upsertProjectTreeDxLibraryMethod;
	prototype.getProjectTreeDxLibrary = getProjectTreeDxLibraryMethod;
	prototype.ensureHubContentSourceTreeDx = ensureHubContentSourceTreeDxMethod;
	prototype.recordTreeDxCredentialIssuance = recordTreeDxCredentialIssuanceMethod;
	prototype.getTreeDxCredentialIssuanceRecord = getTreeDxCredentialIssuanceRecordMethod;
	prototype.updateTreeDxCredentialIssuanceStatus = updateTreeDxCredentialIssuanceStatusMethod;
}
