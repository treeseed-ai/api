import type { ControlPlaneStore } from '../../persistence/store.ts';
import { allMethod } from '../all.ts';
import { upsertHubContentSourceMethod } from '../content/creation/upsert-hub-content-source.ts';
import { getHubContentSourceMethod } from '../content/queries/get-hub-content-source.ts';
import { buildRepositoryTopologySnapshotMethod } from '../repositories/creation/build-repository-topology-snapshot.ts';
import { upsertHubRepositoryMethod } from '../repositories/creation/upsert-hub-repository.ts';
import { batchMethod } from '../support/contracts/batch.ts';
import { ensureInitializedMethod } from '../support/contracts/ensure-initialized.ts';
import { firstMethod } from '../support/contracts/first.ts';
import { runMethod } from '../support/contracts/run.ts';
import { listAuditEventsForTargetMethod } from '../support/queries/list-audit-events-for-target.ts';
import { listHubRepositoriesMethod } from '../support/queries/list-hub-repositories.ts';
import { listRecentAuditEventsMethod } from '../support/queries/list-recent-audit-events.ts';
import { recordAuditEventMethod } from '../support/updates/record-audit-event.ts';

export function installFoundationStoreMethods(prototype: ControlPlaneStore) {
	prototype.run = runMethod;
	prototype.first = firstMethod;
	prototype.all = allMethod;
	prototype.batch = batchMethod;
	prototype.ensureInitialized = ensureInitializedMethod;
	prototype.buildRepositoryTopologySnapshot = buildRepositoryTopologySnapshotMethod;
	prototype.upsertHubRepository = upsertHubRepositoryMethod;
	prototype.listHubRepositories = listHubRepositoriesMethod;
	prototype.upsertHubContentSource = upsertHubContentSourceMethod;
	prototype.getHubContentSource = getHubContentSourceMethod;
	prototype.recordAuditEvent = recordAuditEventMethod;
	prototype.listAuditEventsForTarget = listAuditEventsForTargetMethod;
	prototype.listRecentAuditEvents = listRecentAuditEventsMethod;
}
