import { describe, expect, it } from 'vitest';
import { assertWorkflowContract } from '../../../../src/operations-runner/workflows/github-workflow-executor.ts';

describe('GitHub workflow dispatch contract', () => {
	it('accepts a parsed workflow with a required correlation input and correlated run name', () => {
		expect(() => assertWorkflowContract(`
name: Remote operation
run-name: "TreeSeed \${{ inputs.treeseed_operation_correlation }}"
on:
  workflow_dispatch:
    inputs:
      treeseed_operation_correlation:
        description: Operation correlation
        required: true
        type: string
jobs:
  execute:
    runs-on: ubuntu-latest
    steps: []
`)).not.toThrow();
	});

	it('does not accept workflow-shaped words in comments or script blocks', () => {
		expect(() => assertWorkflowContract(`
name: Unsafe
on: push
jobs:
  execute:
    runs-on: ubuntu-latest
    steps:
      - run: |
          echo "workflow_dispatch:"
          echo "treeseed_operation_correlation:"
          echo "run-name: inputs.treeseed_operation_correlation"
`)).toThrow(/workflow_dispatch/u);
	});

	it('requires correlation to be declared required', () => {
		expect(() => assertWorkflowContract(`
run-name: "\${{ inputs.treeseed_operation_correlation }}"
on:
  workflow_dispatch:
    inputs:
      treeseed_operation_correlation:
        required: false
`)).toThrow(/must require/u);
	});
});
