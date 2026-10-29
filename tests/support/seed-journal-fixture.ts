import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import * as Api from '../../src/server.js';
import { CanonicalJson, SeedSchemas, type SeedPlan, type SeedResourcePlan, type SeedReceipt } from '@treeseed-cordis/sdk';
import { ComposeDeploymentHost } from '@treeseed-cordis/deployment';
import { ServiceReleaseFixture } from '@treeseed-cordis/deployment/testing';
export interface JournalWriter {
  read(): Promise<{ receipt: SeedReceipt | null; intents: string[] }>;
  intent(resource: SeedResourcePlan): Promise<void>;
  publish(receipt: SeedReceipt): Promise<SeedReceipt>;
  close(): Promise<void>;
}
export interface JournalRoot {
  journal: { acquire(plan: unknown, requestId: unknown, signal: AbortSignal): Promise<JournalWriter> };
  close(): Promise<void>;
}
interface JournalConstructor {
  start(authority: { scopeId: string; target: 'api'; principalId: string; resourceScope: string }): Promise<JournalRoot>;
}
/** Synthetic seed authority/artifact identities; genuine plan-only package/OCI custody fixture. */
export class SeedJournalFixture {
  static readonly hash = 'a'.repeat(64);
  readonly release = new ServiceReleaseFixture();
  readonly signal = new AbortController().signal;
  root: JournalRoot | null = null;
  plan!: SeedPlan;
  static type(): JournalConstructor {
    const Type = Reflect.get(Api, 'SeedJournalComposition') as JournalConstructor | undefined;
    assert(Type && typeof Type.start === 'function', 'Public native seed journal composition missing');
    return Type;
  }
  static provider(): SeedResourcePlan['provider'] {
    return { id: 'fixture.provider', capability: 'fixture.resource', target: 'agent',
      scopeId: 'installation:fixture:agent:manager', contractVersion: '1.0.0',
      artifact: { package: '@fixture/provider', version: '1.0.0', integrity: this.hash },
      executableDigest: this.hash };
  }
  static resource(key = 'root'): SeedResourcePlan {
    return SeedSchemas.resourcePlan.parse({ key, kind: 'fixture.resource',
      schema: { id: 'fixture.schema', version: '1.0.0', digest: this.hash },
      requires: ['fixture.resource'], dependsOn: [], providerRequirement: 'fixture.resource',
      provider: this.provider(), owner: 'agent', configurationDigest: this.hash,
      desiredDigest: this.hash, expectedGeneration: null, desiredGeneration: null,
      previousRecord: null, effects: [{ kind: 'fixture.prepare', target: key }] });
  }
  static plan(directory: string, installationId: string): SeedPlan {
    const content = { schemaVersion: 'treeseed.seed-plan/v1', seedDigest: this.hash,
      binding: { installationId, installationDirectory: directory, project: 'fixture-project',
        profile: 'default', principalId: 'subject:fixture', resourceScope: installationId,
        grantId: 'grant:fixture', grantRevision: 1 }, locks: [this.lock()],
      resources: [this.resource()], blockers: [] };
    const digest = CanonicalJson.digest(content);
    return SeedSchemas.plan.parse({ ...content, id: 'seed-plan-' + digest, digest });
  }
  static lock(): SeedPlan['locks'][number] {
    const source = '@fixture/provider@1.0.0';
    return SeedSchemas.lock.parse({ requirement: 'fixture.resource', provider: this.provider(),
      closureDigest: this.hash, source, receipt: { kind: 'npm', locator: source,
        name: '@fixture/provider', version: '1.0.0', archiveDigest: this.hash,
        closureDigest: this.hash, helperDigests: [this.hash],
        sri: 'sha256-' + Buffer.from(this.hash, 'hex').toString('base64'),
        registry: 'https://registry.example.invalid' } });
  }
  static receipt(plan: SeedPlan, requestId = 'fixture-request'): SeedReceipt {
    const resource = plan.resources[0]!;
    return SeedSchemas.receipt.parse({ schemaVersion: 'treeseed.seed-receipt/v1', requestId,
      planId: plan.id, planDigest: plan.digest, binding: plan.binding, state: 'completed',
      expectedResources: plan.resources, resources: [{ key: resource.key, provider: resource.provider,
        desiredDigest: resource.desiredDigest, state: 'verified', owner: resource.owner,
        record: 'fixture-record:root', observedDigest: resource.desiredDigest,
        generation: resource.desiredGeneration, blockers: [] }], blockers: [] });
  }
  async prepare(): Promise<void> {
    await this.release.services();
    const deployment = await new ComposeDeploymentHost().plan(this.release.configuration);
    this.plan = SeedJournalFixture.plan(this.release.installation, deployment.configuration.installationId);
    await this.open();
  }
  async open(): Promise<void> {
    this.root = await SeedJournalFixture.type().start({ scopeId: 'api:' + this.plan.binding.installationId,
      target: 'api', principalId: this.plan.binding.principalId, resourceScope: this.plan.binding.resourceScope });
  }
  acquire(requestId = 'fixture-request', plan: unknown = this.plan): Promise<JournalWriter> {
    assert(this.root);
    return this.root.journal.acquire(plan, requestId, this.signal);
  }
  get directory(): string {
    return join(this.release.installation, '.cordis/artifacts/records/seeds');
  }
  marker(): Buffer {
    return readFileSync(join(this.release.installation, '.cordis/installation.json'));
  }
  permissions(): void {
    assert.equal(statSync(this.directory).mode & 0o777, 0o700);
    assert.equal(existsSync(join(this.release.root, 'SCRIPT_CANARY')), false);
  }
  async close(): Promise<void> {
    try { await this.root?.close(); } finally { this.release.close(); }
  }
  async restartWithoutBundle(): Promise<void> {
    await this.root?.close();
    this.root = null;
    rmSync(this.release.bundle, { recursive: true });
    await this.open();
  }
}
