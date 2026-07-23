import type { MarketControlPlaneStore } from '../store.ts';
import { installAccountsStoreMethods } from './installers/accounts.ts';
import { installCatalogStoreMethods } from './installers/catalog.ts';
import { installCommerceStoreMethods } from './installers/commerce.ts';
import { installCredentialsStoreMethods } from './installers/credentials.ts';
import { installFoundationStoreMethods } from './installers/foundation.ts';
import { installGovernanceStoreMethods } from './installers/governance.ts';
import { installOperationsStoreMethods } from './installers/operations.ts';
import { installProjectsStoreMethods } from './installers/projects.ts';
import { installTeamsStoreMethods } from './installers/teams.ts';
import { installTreedxStoreMethods } from './installers/treedx.ts';

export function installMarketControlPlaneStoreMethods(prototype: MarketControlPlaneStore) {
	installAccountsStoreMethods(prototype);
	installCatalogStoreMethods(prototype);
	installCommerceStoreMethods(prototype);
	installCredentialsStoreMethods(prototype);
	installFoundationStoreMethods(prototype);
	installGovernanceStoreMethods(prototype);
	installOperationsStoreMethods(prototype);
	installProjectsStoreMethods(prototype);
	installTeamsStoreMethods(prototype);
	installTreedxStoreMethods(prototype);
}
