import { readFileSync } from 'node:fs';
import { authClass } from '../accounts/authorization-policy.js';
import { safeProduction } from '../commerce/catalog/production-safety.js';
import { ownerDomain,routeId,runtimePlane } from '../commerce/ownership/route-ownership.js';
import { endpointGuarantee } from '../guarantees/guarantee-coverage.js';
import { fixtureRequirements } from '../testing/fixture-requirements.js';
import { acceptancePolicy } from './acceptance-policy.js';
import { mutability } from './mutability-policy.js';
import { applicationRouteSourcePaths,appSourcePath,capacityRouteSourcePaths } from './route-source-discovery.js';
import { SDK_METHOD_ROUTE_MAP } from './sdk-route-map.js';

export function extractActiveApiRoutes(source = [
    appSourcePath,
    ...applicationRouteSourcePaths(),
    ...capacityRouteSourcePaths(),
].map((path) => readFileSync(path, 'utf8')).join('\n')) {
    const routes = [];
    const pattern = /app\.(get|post|put|patch|delete)\(\s*['"]([^'"]+)['"]/gu;
    for (const match of source.matchAll(pattern)) {
        const method = match[1].toLowerCase();
        const path = match[2];
        if (!path.startsWith('/v1'))
            continue;
        routes.push({
            id: routeId(method, path),
            method: method.toUpperCase(),
            path,
            runtimePlane: runtimePlane(path),
            ownerDomain: ownerDomain(path),
            authClass: authClass(path, method),
            mutability: mutability(method),
            safeProduction: safeProduction(path, method),
            fixtures: fixtureRequirements(path),
            providerIngress: path.startsWith('/v1/provider/') || path.startsWith('/v1/provider-registrations'),
            internalRunner: path.startsWith('/v1/platform/runners/'),
            acceptance: acceptancePolicy(path, method),
            guarantee: endpointGuarantee(path),
        });
    }
    return routes.sort((left, right) => left.id.localeCompare(right.id));
}

export const API_ROUTE_DESCRIPTORS = extractActiveApiRoutes().map((descriptor) => {
    const sdkMethods = Object.entries(SDK_METHOD_ROUTE_MAP)
        .filter(([, routeIdValue]) => routeIdValue === descriptor.id)
        .map(([method]) => method);
    return sdkMethods.length > 0 ? { ...descriptor, sdkMethods } : descriptor;
});

export function descriptorById(id) {
    return API_ROUTE_DESCRIPTORS.find((descriptor) => descriptor.id === id) ?? null;
}
