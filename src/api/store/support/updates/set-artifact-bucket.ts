import { ControlPlaneStore } from "../../../persistence/store.ts";
export function setArtifactBucketMethod(this: ControlPlaneStore, bucket: unknown) {
    this.artifactBucket = bucket && typeof bucket === 'object' ? bucket : null;
}
