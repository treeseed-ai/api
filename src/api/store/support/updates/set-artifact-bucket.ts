import { MarketControlPlaneStore } from "../../../persistence/store.ts";
export function setArtifactBucketMethod(this: MarketControlPlaneStore, bucket) {
    this.artifactBucket = bucket && typeof bucket === 'object' ? bucket : null;
}
