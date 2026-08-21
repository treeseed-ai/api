import { ControlPlaneStore } from "../../../persistence/store.ts";
export function setArtifactBucketMethod(this: ControlPlaneStore, bucket) {
    this.artifactBucket = bucket && typeof bucket === 'object' ? bucket : null;
}
