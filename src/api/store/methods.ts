import type { MarketControlPlaneStore } from '../persistence/store.ts';
import { installAccountsStoreMethods } from './installers/accounts.ts';
import { installCatalogStoreMethods } from './installers/catalog.ts';
import { installCommerceStoreMethods } from './installers/commerce.ts';
import { installFoundationStoreMethods } from './installers/foundation.ts';
import { installGovernanceStoreMethods } from './installers/governance.ts';
import { installKnowledgeStoreMethods } from './installers/knowledge.ts';
import { installOperationsStoreMethods } from './installers/operations.ts';
import { installProjectsStoreMethods } from './installers/projects.ts';
import { installTeamsStoreMethods } from './installers/teams.ts';
import { installTreedxStoreMethods } from './installers/treedx.ts';

export function installMarketControlPlaneStoreMethods(prototype: MarketControlPlaneStore) {
	installAccountsStoreMethods(prototype);
	installCatalogStoreMethods(prototype);
	installCommerceStoreMethods(prototype);
	installFoundationStoreMethods(prototype);
	installGovernanceStoreMethods(prototype);
	installKnowledgeStoreMethods(prototype);
	installOperationsStoreMethods(prototype);
	installProjectsStoreMethods(prototype);
	installTeamsStoreMethods(prototype);
	installTreedxStoreMethods(prototype);
}
