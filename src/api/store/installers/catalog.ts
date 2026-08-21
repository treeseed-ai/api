import type { ControlPlaneStore } from '../../persistence/store.ts';
import { readRuntimeArtifactContentMethod } from '../content/queries/read-runtime-artifact-content.ts';
import { uploadRuntimeArtifactMethod } from '../runtime/creation/upload-runtime-artifact.ts';
import { createSeedRunMethod } from '../seeds/creation/create-seed-run.ts';
import { getSeedRunMethod } from '../seeds/queries/get-seed-run.ts';
import { listSeedRunsMethod } from '../seeds/queries/list-seed-runs.ts';
import { updateSeedRunMethod } from '../seeds/updates/update-seed-run.ts';
import { setArtifactBucketMethod } from '../support/updates/set-artifact-bucket.ts';

export function installCatalogStoreMethods(prototype: ControlPlaneStore) {
	prototype.setArtifactBucket = setArtifactBucketMethod;
	prototype.createSeedRun = createSeedRunMethod;
	prototype.updateSeedRun = updateSeedRunMethod;
	prototype.getSeedRun = getSeedRunMethod;
	prototype.listSeedRuns = listSeedRunsMethod;
	prototype.uploadRuntimeArtifact = uploadRuntimeArtifactMethod;
	prototype.readRuntimeArtifactContent = readRuntimeArtifactContentMethod;
}
