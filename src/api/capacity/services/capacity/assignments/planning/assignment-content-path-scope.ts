import { CapacityGovernanceError } from '../../../../database.ts';

type JsonRecord=Record<string,unknown>;
function record(value:unknown):JsonRecord{return value&&typeof value==='object'&&!Array.isArray(value)?value as JsonRecord:{};}
export function resolveAssignmentContentPathScope(payload:JsonRecord,access:'read'|'write',contentRoot:string,fallback:string[]):string[]{
	const allowed=access==='read'?new Set(['describe','query','read']):new Set(['create','update','link','validate','commit']);const root=contentRoot.replace(/\\/gu,'/').replace(/\/+$/u,'');const collections:Record<string,string>={agent:'agents',book:'books',decision:'decisions',knowledge:'knowledge',note:'notes',objective:'objectives',proposal:'proposals',question:'questions'};let authorized=0;
	const configured=Object.entries(record(record(payload.permissions).content)).flatMap(([model,grant])=>{const policy=record(grant);const operations=Array.isArray(policy.operations)?policy.operations.map(String):[];if(!operations.some((operation)=>allowed.has(operation)))return [];authorized+=1;const paths=record(policy.filters).paths;if(Array.isArray(paths)&&paths.length)return paths;return collections[model]?[`${root}/${collections[model]}/**`]:[];});
	if(authorized===0)return fallback;const paths=configured.map(String).map((value)=>value.trim().replace(/\\/gu,'/').replace(/^\.\//u,'')).filter(Boolean);const invalid=paths.filter((value)=>value.startsWith('/')||value.split('/').includes('..')||(value!==root&&!value.startsWith(`${root}/`)));if(invalid.length)throw new CapacityGovernanceError('capacity_workday_content_path_scope_invalid','Agent content access contains a path outside the project content root.',500,{contentRoot,access,invalid});return [...new Set(paths)];
}
