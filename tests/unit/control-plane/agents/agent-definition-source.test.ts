import { describe,expect,it } from 'vitest';
import { REPOSITORY_DEFINITION_EXTENSIONS,repositoryDefinitionSource,validateAgentDefinitionSource } from '../../../../src/api/control-plane/repositories/agents/agent-definition-source.ts';

const validSource = `---
id: agent:architect
slug: architect
title: Architect
name: Architect
description: Plans governed work.
summary: Plans governed work.
agentClass: architecture
projectAgentClassId: architecture
projectAgentClassSlug: architecture
enabled: true
groupIds: [architecture]
identity:
  purpose: Plan governed work.
  responsibilities: [Inspect evidence]
  durableInstructions: Preserve human decision authority.
activityProfiles:
  planning:
    activityType: planning
    enabled: true
    handler: writer
    prompt: { system: Inspect evidence. }
    branchPolicy: { kind: staging-content, base: staging }
    tools: { allowed: [treeseed.content.create] }
    outputs: { messageTypes: [], modelMutations: [proposal:create] }
---
`;

describe('agent definition source validation', () => {
	it('uses the dotted extension contract required by TreeDX repository queries', () => {
		expect(REPOSITORY_DEFINITION_EXTENSIONS).toEqual(['.md', '.mdx', '.yaml', '.yml']);
	});

	it('validates full frontmatter with the portable Zod contract', () => {
		expect(validateAgentDefinitionSource(validSource)).toMatchObject({ ok: true, diagnostics: [] });
	});

	it('returns exact nested paths for CLI and chat correction feedback', () => {
		const invalid = validSource.replace('prompt: { system: Inspect evidence. }', 'prompt: { system: 42 }');
		const validation = validateAgentDefinitionSource(invalid);
		expect(validation.ok).toBe(false);
		expect(validation.diagnostics).toEqual(expect.arrayContaining([
			expect.objectContaining({ path: 'activityProfiles.planning.prompt.system' }),
		]));
	});

	it('reconstructs a complete document from TreeDX parsed file fields', () => {
		const source = repositoryDefinitionSource({ frontmatter: { id: 'agent:architect', enabled: true }, content: '\nAgent body.\n' });
		expect(source).toContain('id: agent:architect');
		expect(source).toContain('\n---\nAgent body.\n');
	});

	it('prefers exact raw content over a lossy parsed TreeDX frontmatter projection', () => {
		const source = repositoryDefinitionSource({
			frontmatter: { outputs: { messageTypes: '' } },
			content: '---\noutputs:\n  messageTypes: []\n---\nBody.\n',
		});
		expect(source).toBe('---\noutputs:\n  messageTypes: []\n---\nBody.\n');
	});
});
