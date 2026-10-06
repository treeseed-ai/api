import { CapacityGovernanceError } from '../../../../database.ts';

type JsonRecord=Record<string,unknown>;
function record(value:unknown):JsonRecord{return value&&typeof value==='object'&&!Array.isArray(value)?value as JsonRecord:{};}
export function resolveAssignmentContentPathScope(payload:JsonRecord,access:'read'|'write',contentRoot:string,fallback:string[]):string[]{
	const allowed=access==='read'?new Set(['describe','query','read']):new Set(['create','update','link','validate','commit']);const normalizedRoot=contentRoot.replace(/\\/gu,'/').replace(/\/+$/u,'').replace(/^\.\//u,'');const root=normalizedRoot==='.'?'':normalizedRoot;const collections:Record<string,string>={agent:'agents',book:'books',decision:'decisions',execution_plan:'execution-plans',knowledge:'knowledge',note:'notes',objective:'objectives',proposal:'proposals',question:'questions'};let authorized=0;
	const configured=Object.entries(record(record(payload.permissions).content)).flatMap(([model,grant])=>{const policy=record(grant);const operations=Array.isArray(policy.operations)?policy.operations.map(String):[];if(!operations.some((operation)=>allowed.has(operation)))return [];authorized+=1;const paths=record(policy.filters).paths;if(Array.isArray(paths)&&paths.length)return paths;return collections[model]?[`${root?`${root}/`:''}${collections[model]}/**`]:[];});
	const repository=record(record(payload.permissions).repository);const repositoryPaths=repository[access==='read'?'readPaths':'writePaths'];if(Array.isArray(repositoryPaths)&&repositoryPaths.length){authorized+=1;configured.push(...repositoryPaths);}
	const paths=(authorized===0?fallback:configured).map(String).map((value)=>value.trim().replace(/\\/gu,'/').replace(/^\.\//u,'')).filter(Boolean);const invalid=paths.filter((value)=>value.startsWith('/')||value.split('/').includes('..')||(Boolean(root)&&value!==root&&!value.startsWith(`${root}/`)));if(invalid.length)throw new CapacityGovernanceError('capacity_workday_content_path_scope_invalid','Agent content access contains a path outside the project content root.',500,{contentRoot,access,invalid});return [...new Set(paths)];
}

/** Restrict a resolved content grant to a compiler-declared output boundary. */
export function constrainAssignmentContentPathScope(authorized:string[],requested:string[]):string[]{
	const normalized=[...new Set(requested.map((value)=>value.trim().replace(/\\/gu,'/').replace(/^\.\//u,'')).filter(Boolean))];
	const covered=(path:string,grant:string)=>grant==='**'||grant===path||(grant.endsWith('/**')&&(
		path===grant.slice(0,-3)||path.startsWith(`${grant.slice(0,-3)}/`)));
	const denied=normalized.filter((path)=>!authorized.some((grant)=>covered(path,grant)));
	if(denied.length)throw new CapacityGovernanceError('capacity_workday_output_path_scope_invalid','Declared assignment outputs exceed the agent content grant.',500,{authorized,denied});
	return normalized;
}
