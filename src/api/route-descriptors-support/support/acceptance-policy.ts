import { successActorsFor } from '../accounts/authorization-policy.js';
import { productionSafeStrategy } from '../commerce/catalog/production-safety.js';
import { ACCEPTANCE_ACTORS } from './actor-groups.js';
import { bodyFactoryFor } from './request-body-factories.js';

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
