/** Configuration access is narrower than dispatch authority and is rechecked by the runner. */
export function workflowConfigurationNames(policy: unknown, target: {repositoryBindingId:string;kind:'secrets'|'variables';scope:string;environment?:string|null}) {
  let value: unknown;
  try { value = typeof policy === 'string' ? JSON.parse(policy) : policy; } catch { return []; }
  const declarations = (value as any)?.workflowConfiguration;
  if (!Array.isArray(declarations)) return [];
  // Organization-wide writes can affect unrelated projects; they are not workflow-scoped.
  if (!['repository','environment'].includes(target.scope)) return [];
  return [...new Set(declarations.filter(item => item &&
    /^\.github\/workflows\/[A-Za-z0-9._-]+\.ya?ml$/u.test(item.workflowPath) &&
    item.repositoryBindingId===target.repositoryBindingId && item.kind===target.kind && item.scope===target.scope &&
    (item.environment??null)===(target.environment??null) && Array.isArray(item.names))
    .flatMap(item=>item.names).filter((name:unknown):name is string=>typeof name==='string'&&/^[A-Z_][A-Z0-9_]{0,99}$/u.test(name)))];
}

export function requireWorkflowConfigurationName(policy: unknown, target: Parameters<typeof workflowConfigurationNames>[1], name:string) {
  if (!workflowConfigurationNames(policy,target).includes(name)) throw Object.assign(new Error('This name and scope are not declared by an authorized workflow.'),{status:403,code:'workflow_configuration_not_declared'});
}
