import { API_ROUTE_DESCRIPTORS } from '../../../src/api/support/route-descriptors.ts';

export function assertCoverage(spec, cases) {
    const required = Array.isArray(spec.coverage?.requiredCaseIds) ? spec.coverage.requiredCaseIds : [];
    const ids = new Set(cases.map((entry) => entry.id));
    const missing = required.filter((id) => !ids.has(id));
    if (missing.length > 0) {
        throw new Error(`Acceptance spec is missing required case ids: ${missing.join(', ')}`);
    }
    if (spec.coverage?.requireAllDescriptors) {
        const coveredDescriptors = new Set(cases.map((entry) => entry.descriptorId).filter(Boolean));
        const missingDescriptors = API_ROUTE_DESCRIPTORS
            .filter((descriptor) => !coveredDescriptors.has(descriptor.id))
            .filter((descriptor) => !(spec.coverage.exemptDescriptorIds ?? []).includes(descriptor.id));
        if (missingDescriptors.length > 0) {
            throw new Error(`Acceptance spec is missing descriptor coverage for: ${missingDescriptors.map((entry) => entry.id).join(', ')}`);
        }
    }
    const looseGenerated = cases
        .filter((entry) => entry.id?.startsWith?.('descriptor-executable-role-matrix.'))
        .filter((entry) => Array.isArray(entry.expect?.statusAny));
    if (looseGenerated.length > 0) {
        throw new Error(`Descriptor-generated acceptance cases must use exact statuses, found loose cases: ${looseGenerated.slice(0, 10).map((entry) => entry.id).join(', ')}`);
    }
}
