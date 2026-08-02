import { artifactStorageRoot,getNodeBuiltin,MarketControlPlaneStore,safeStoragePathSegment } from "../../../persistence/store.ts";
export async function readRuntimeArtifactContentMethod(this: MarketControlPlaneStore, projectId, outputRef) {
    const fs = getNodeBuiltin('fs');
    const path = getNodeBuiltin('path');
    const root = artifactStorageRoot(this.config);
    if (!fs || !path || !root || typeof outputRef !== 'string' || !outputRef.startsWith('r2:'))
        return null;
    const objectKey = safeStoragePathSegment(outputRef.slice(3));
    if (!objectKey)
        return null;
    const filePath = path.resolve(root, projectId, objectKey);
    if (!filePath.startsWith(path.resolve(root, projectId) + path.sep))
        return null;
    try {
        return await fs.promises.readFile(filePath, 'utf8');
    }
    catch {
        return null;
    }
}
