import { createHash } from 'node:crypto';

const VERSION='v5';
function projection(value:Record<string,unknown>){return {id:value.id,slug:value.slug,name:value.name,status:value.status,allowedModes:value.allowedModes,requiredCapabilities:value.requiredCapabilities,handlerRefs:value.handlerRefs,metadata:value.metadata};}
export function projectionDigest(value:Record<string,unknown>){return createHash('sha256').update(JSON.stringify(projection(value))).digest('hex').slice(0,16);}
export function agentClassProjectionIdempotencyKey(commit:string,classSlug:string,desired:Record<string,unknown>={},observed:Record<string,unknown>={}){return `agent-lab-sync:${VERSION}:${commit}:${classSlug}:${projectionDigest(desired)}:${projectionDigest(observed)}`;}
