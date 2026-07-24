import type { MarketControlPlaneStore } from '../../persistence/store.ts';
import { getPrimaryTreeDxInstanceMethod } from '../treedx/repositories/queries/get-primary-tree-dx-instance.ts';
import { getTeamTreeDxMethod } from '../treedx/repositories/queries/get-team-tree-dx.ts';
import { upsertTeamTreeDxMethod } from '../treedx/repositories/creation/upsert-team-tree-dx.ts';
import { provisionTeamTreeDxMethod } from '../treedx/repositories/creation/provision-team-tree-dx.ts';
import { updateTreeDxDeploymentMethod } from '../treedx/repositories/updates/update-tree-dx-deployment.ts';
import { listTreeDxDeploymentsMethod } from '../treedx/repositories/queries/list-tree-dx-deployments.ts';
import { listTreeDxMirrorsMethod } from '../treedx/repositories/queries/list-tree-dx-mirrors.ts';
import { createTreeDxMirrorMethod } from '../treedx/repositories/creation/create-tree-dx-mirror.ts';
import { syncTreeDxMirrorMethod } from '../treedx/repositories/updates/sync-tree-dx-mirror.ts';
import { listTreeDxSharesMethod } from '../treedx/repositories/queries/list-tree-dx-shares.ts';
import { createTreeDxShareMethod } from '../treedx/repositories/creation/create-tree-dx-share.ts';
import { upsertProjectTreeDxLibraryMethod } from '../projects/knowledge/creation/upsert-project-tree-dx-library.ts';
import { getProjectTreeDxLibraryMethod } from '../projects/knowledge/queries/get-project-tree-dx-library.ts';
import { ensureHubContentSourceTreeDxMethod } from '../treedx/repositories/contracts/ensure-hub-content-source-tree-dx.ts';
import { recordTreeDxCredentialIssuanceMethod } from '../treedx/repositories/updates/record-tree-dx-credential-issuance.ts';
import { getTreeDxCredentialIssuanceRecordMethod } from '../treedx/repositories/queries/get-tree-dx-credential-issuance-record.ts';
import { updateTreeDxCredentialIssuanceStatusMethod } from '../treedx/repositories/updates/update-tree-dx-credential-issuance-status.ts';

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
