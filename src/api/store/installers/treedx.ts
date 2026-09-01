import type { ControlPlaneStore } from '../../persistence/store.ts';
import { upsertProjectTreeDxLibraryMethod } from '../projects/knowledge/creation/upsert-project-tree-dx-library.ts';
import { getProjectTreeDxLibraryMethod } from '../projects/knowledge/queries/get-project-tree-dx-library.ts';
import { ensureHubContentSourceTreeDxMethod } from '../treedx/repositories/contracts/ensure-hub-content-source-tree-dx.ts';
import { createTreeDxMirrorMethod } from '../treedx/repositories/creation/create-tree-dx-mirror.ts';
import { createTreeDxShareMethod } from '../treedx/repositories/creation/create-tree-dx-share.ts';
import { upsertTeamTreeDxMethod } from '../treedx/repositories/creation/upsert-team-tree-dx.ts';
import { getPrimaryTreeDxInstanceMethod } from '../treedx/repositories/queries/get-primary-tree-dx-instance.ts';
import { getTeamTreeDxMethod } from '../treedx/repositories/queries/get-team-tree-dx.ts';
import { listTreeDxDeploymentsMethod } from '../treedx/repositories/queries/list-tree-dx-deployments.ts';
import { listTreeDxMirrorsMethod } from '../treedx/repositories/queries/list-tree-dx-mirrors.ts';
import { listTreeDxSharesMethod } from '../treedx/repositories/queries/list-tree-dx-shares.ts';
import { getTreeDxShareMethod } from '../treedx/repositories/queries/get-tree-dx-share.ts';
import { listTreeDxSharesForRecipientMethod } from '../treedx/repositories/queries/list-tree-dx-shares-for-recipient.ts';
import { revokeTreeDxShareMethod } from '../treedx/repositories/updates/revoke-tree-dx-share.ts';
import { syncTreeDxMirrorMethod } from '../treedx/repositories/updates/sync-tree-dx-mirror.ts';
import { updateTreeDxDeploymentMethod } from '../treedx/repositories/updates/update-tree-dx-deployment.ts';

export function installTreedxStoreMethods(prototype: ControlPlaneStore) {
	prototype.getPrimaryTreeDxInstance = getPrimaryTreeDxInstanceMethod;
	prototype.getTeamTreeDx = getTeamTreeDxMethod;
	prototype.upsertTeamTreeDx = upsertTeamTreeDxMethod;
	prototype.updateTreeDxDeployment = updateTreeDxDeploymentMethod;
	prototype.listTreeDxDeployments = listTreeDxDeploymentsMethod;
	prototype.listTreeDxMirrors = listTreeDxMirrorsMethod;
	prototype.createTreeDxMirror = createTreeDxMirrorMethod;
	prototype.syncTreeDxMirror = syncTreeDxMirrorMethod;
	prototype.listTreeDxShares = listTreeDxSharesMethod;
	prototype.createTreeDxShare = createTreeDxShareMethod;
	prototype.getTreeDxShare = getTreeDxShareMethod;
	prototype.listTreeDxSharesForRecipient = listTreeDxSharesForRecipientMethod;
	prototype.revokeTreeDxShare = revokeTreeDxShareMethod;
	prototype.upsertProjectTreeDxLibrary = upsertProjectTreeDxLibraryMethod;
	prototype.getProjectTreeDxLibrary = getProjectTreeDxLibraryMethod;
	prototype.ensureHubContentSourceTreeDx = ensureHubContentSourceTreeDxMethod;
}
