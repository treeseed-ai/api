import { createHash } from 'node:crypto';
import { artifactStorageRoot,getNodeBuiltin,isoNow,MarketControlPlaneStore,safeStoragePathSegment } from "../../../persistence/store.ts";
export async function uploadRuntimeArtifactMethod(this: MarketControlPlaneStore, projectId, input) {
    await this.ensureInitialized();
    const fs = getNodeBuiltin('fs');
    const path = getNodeBuiltin('path');
    const root = artifactStorageRoot(this.config);
    const objectKey = safeStoragePathSegment(input.objectKey);
    if (!fs || !path || !root || !objectKey)
        return null;
    const contentType = typeof input.contentType === 'string' && input.contentType.trim()
        ? input.contentType.trim()
        : 'application/octet-stream';
    const bytes = typeof input.contentBase64 === 'string' && input.contentBase64
        ? Buffer.from(input.contentBase64, 'base64')
        : Buffer.from(typeof input.content === 'string' ? input.content : JSON.stringify(input.content ?? {}));
    const destination = path.resolve(root, projectId, objectKey);
    if (!destination.startsWith(path.resolve(root, projectId) + path.sep))
        return null;
    await fs.promises.mkdir(path.dirname(destination), { recursive: true });
    await fs.promises.writeFile(destination, bytes);
    return {
        artifactStorage: 'r2',
        storageMode: 'local_r2_emulation',
        outputRef: `r2:${objectKey}`,
        objectKey,
        contentType,
        sizeBytes: bytes.byteLength,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        teamId: null,
        projectId,
        createdAt: isoNow(),
    };
}
