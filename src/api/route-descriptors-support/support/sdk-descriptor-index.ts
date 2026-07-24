import { API_ROUTE_DESCRIPTORS, SDK_METHOD_ROUTE_MAP } from '../index.js';

export function descriptorsForSdkMethods() {
    const byId = new Map(API_ROUTE_DESCRIPTORS.map((descriptor) => [descriptor.id, descriptor]));
    return Object.fromEntries(Object.entries(SDK_METHOD_ROUTE_MAP).map(([method, id]) => [method, byId.get(id) ?? null]));
}
