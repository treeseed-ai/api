import { type BuildInfrastructureProjectionInput, type InfrastructureBundle } from '../infrastructure-projection.js';
import { call } from './index.js';

export async function loadProjectBundle(input: BuildInfrastructureProjectionInput, project: any): Promise<InfrastructureBundle> {
    const store = input.store;
    const [summary, details, agents, releases, capacityOperations] = await Promise.all([
        call(store, 'getProjectSummary', project.id, input.principal),
        call(store, 'getProjectDetails', project.id),
        call(store, 'getProjectAgentsSummary', project.id, input.principal),
        call(store, 'getProjectReleasesSummary', project.id, input.principal),
        call(store, 'getProjectCapacityOperations', project.id, 'staging'),
    ]);
    return { project, summary, details, agents, releases, capacityOperations };
}
