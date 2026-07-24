import { successActorsFor, productionSafeStrategy, bodyFactoryFor, ACCEPTANCE_ACTORS } from '../index.js';

export function acceptancePolicy(path, method) {
    const successActors = successActorsFor(path, method);
    return {
        bodyFactory: bodyFactoryFor(path, method),
        successActors,
        denyActors: ACCEPTANCE_ACTORS.filter((actor) => !successActors.includes(actor)),
        expectedSuccessStatus: method === 'post' && (path.startsWith('/v1/platform/operations') || path.includes('/retry')) ? 202 : 200,
        exactStatusRequired: true,
        cleanup: method === 'delete' ? 'disposable-fixture' : 'acceptance-owned-fixture',
        productionSafe: true,
        productionStrategy: productionSafeStrategy(path, method),
    };
}
