import { AGENT_TASK_SIGNATURES } from '../index.ts';
export function resolveAgentTaskSignature(value) {
    const signature = typeof value === 'string' && value.trim() ? value.trim() : 'proposal.draft';
    return {
        signature,
        definition: AGENT_TASK_SIGNATURES[signature] ?? AGENT_TASK_SIGNATURES['proposal.draft'],
    };
}
