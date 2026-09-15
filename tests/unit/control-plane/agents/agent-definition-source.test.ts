import { describe,expect,it } from 'vitest';
import { REPOSITORY_DEFINITION_EXTENSIONS,repositoryDefinitionSource,validateAgentDefinitionSource } from '../../../../src/api/control-plane/repositories/agents/agent-definition-source.ts';

const validSource = `---
schemaVersion: treeseed.agent/v1
id: sdk/architect
name: Architect
agentClass: architect
purpose: Plan governed work.
responsibilities: [Inspect exact evidence.]
capabilities: [architecture-analysis]
context:
  include: [project-objectives]
activityProfiles:
  planning:
    handler: writer
    permissions:
      content: { read: [knowledge, objective], write: [proposal] }
      tools: [source.read]
    prompt: { system: Inspect exact evidence and propose bounded work. }
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
		const invalid = validSource.replace('prompt: { system: Inspect exact evidence and propose bounded work. }', 'prompt: { system: 42 }');
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

	it('rejects the legacy agent-execution marker rather than migrating repository content', () => {
		const legacy = validSource.replace('    permissions:\n', '    execution:\n      requiredCapabilities: [agent-execution]\n    permissions:\n');
		const source = repositoryDefinitionSource({ content: legacy });
		expect(source).toContain('requiredCapabilities');
		expect(validateAgentDefinitionSource(source).ok).toBe(false);
	});
});
