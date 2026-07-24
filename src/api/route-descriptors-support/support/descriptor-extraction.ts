import { readFileSync } from 'node:fs';
import { authClass, mutability, fixtureRequirements, endpointGuarantee, safeProduction, acceptancePolicy, appSourcePath, projectDeploymentRoutesSourcePath, capacityRouteSourcePaths, SDK_METHOD_ROUTE_MAP, routeId, ownerDomain, applicationRouteSourcePaths } from '../index.js';

export function extractActiveApiRoutes(source = [
    appSourcePath,
    projectDeploymentRoutesSourcePath,
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
