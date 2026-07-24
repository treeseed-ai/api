import { API_ROUTE_DESCRIPTORS } from '../../../src/api/support/route-descriptors.ts';
import { descriptorPath, bodyForFactory, expectedForDescriptor, matchesCaseFilter, loadExpectedStatuses } from '../index.js';

export function expandDescriptorMatrices(spec, expectedStatuses = loadExpectedStatuses(spec.expectedStatuses), caseId = '') {
    const matrices = Array.isArray(spec.descriptorMatrices) ? spec.descriptorMatrices : [];
    const expanded = [];
    for (const matrix of matrices) {
        const actors = Array.isArray(matrix.actors) ? matrix.actors : [];
        const methods = new Set(Array.isArray(matrix.methods) ? matrix.methods.map((entry) => String(entry).toUpperCase()) : ['GET']);
        const domains = new Set(Array.isArray(matrix.ownerDomains) ? matrix.ownerDomains : []);
        const authClasses = new Set(Array.isArray(matrix.authClasses) ? matrix.authClasses : []);
        const ids = new Set(Array.isArray(matrix.ids) ? matrix.ids : []);
        for (const descriptor of API_ROUTE_DESCRIPTORS) {
            if (ids.size > 0 && !ids.has(descriptor.id))
                continue;
            if (ids.size === 0 && !methods.has(descriptor.method))
                continue;
            if (domains.size > 0 && !domains.has(descriptor.ownerDomain))
                continue;
            if (authClasses.size > 0 && !authClasses.has(descriptor.authClass))
                continue;
            if (matrix.excludeProviderIngress !== false && descriptor.providerIngress)
                continue;
            if (matrix.excludeInternalRunner !== false && descriptor.internalRunner)
                continue;
            for (const actor of actors) {
                const id = `${matrix.id}.${descriptor.id}.${actor}`;
                if (!matchesCaseFilter(caseId, id))
                    continue;
                const expected = {
                    ...(matrix.expect ?? {}),
                    ...expectedForDescriptor(descriptor, actor, expectedStatuses),
                    ...(matrix.expectByDescriptor?.[descriptor.id]?.[actor] ?? matrix.expectByDescriptor?.[descriptor.id] ?? {}),
                };
                const body = bodyForFactory(descriptor.acceptance?.bodyFactory, descriptor, actor);
                expanded.push({
                    id,
                    actor,
                    method: descriptor.method,
                    path: descriptorPath(descriptor),
                    body,
                    expect: expected,
                    descriptorId: descriptor.id,
                    coverageOnly: matrix.coverageOnly === true,
                    environments: matrix.environments,
                });
            }
        }
    }
    return expanded;
}
