import { AGENT_TASK_SIGNATURES } from '../index.ts';
export function resolveAgentTaskSignature(value: unknown) {
    const signature = typeof value === 'string' && value.trim() ? value.trim() : 'proposal.draft';
    const signatures: Readonly<Record<string, typeof AGENT_TASK_SIGNATURES[keyof typeof AGENT_TASK_SIGNATURES]>> = AGENT_TASK_SIGNATURES;
    return {
        signature,
        definition: signatures[signature] ?? AGENT_TASK_SIGNATURES['proposal.draft'],
    };
}
