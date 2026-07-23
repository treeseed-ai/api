import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { here, findPackageRoot, packageRoot, sourcePathFor, appSourcePath, projectDeploymentRoutesSourcePath, capacityRouteSourcePaths, SDK_METHOD_ROUTE_MAP, ACCEPTANCE_ACTORS, TEAM_MEMBER_ACTORS, TEAM_MANAGER_ACTORS, PROJECT_MEMBER_ACTORS, PROJECT_MANAGER_ACTORS, PLATFORM_ADMIN_ACTORS, routeId, isTreeDxCredentialBridgePath, ownerDomain, authClass, mutability, fixtureRequirements, API_ENDPOINT_GUARANTEE_FAMILIES, endpointGuaranteeFamily, endpointGuaranteeCoverage, endpointGuarantee, safeProduction, routeNeedsManagement, successActorsFor, productionSafeStrategy, bodyFactoryFor, acceptancePolicy, extractActiveApiRoutes, API_ROUTE_DESCRIPTORS, descriptorById } from './index.js';

export function descriptorsForSdkMethods() {
    const byId = new Map(API_ROUTE_DESCRIPTORS.map((descriptor) => [descriptor.id, descriptor]));
    return Object.fromEntries(Object.entries(SDK_METHOD_ROUTE_MAP).map(([method, id]) => [method, byId.get(id) ?? null]));
}
