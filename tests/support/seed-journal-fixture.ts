import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import * as Api from '../../src/server.js';
import {
  CanonicalJson,
  SeedSchemas,
  type SeedPlan,
  type SeedResourcePlan,
  type SeedReceipt,
} from '@treeseed-cordis/sdk';
import {
  InstallationRecords,
  type InstallationRecord,
  ComposeDeploymentHost,
} from '@treeseed-cordis/deployment';
import { ServiceReleaseFixture } from '@treeseed-cordis/deployment/testing';
export interface JournalWriter {
  read(): Promise<{ receipt: SeedReceipt | null; intents: string[] }>;
  intent(resource: SeedResourcePlan): Promise<void>;
  publish(receipt: SeedReceipt): Promise<SeedReceipt>;
  close(): Promise<void>;
}
export interface JournalRoot {
  journal: {
    acquire(plan: unknown, requestId: unknown, signal: AbortSignal): Promise<JournalWriter>;
  };
  close(): Promise<void>;
}
interface JournalConstructor {
  start(authority: {
    scopeId: string;
    target: 'api';
    principalId: string;
    resourceScope: string;
  }): Promise<JournalRoot>;
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
    assert(
      Type && typeof Type.start === 'function',
      'Public native seed journal composition missing',
    );
    return Type;
  }
  static provider(): SeedResourcePlan['provider'] {
    return {
      id: 'fixture.provider',
      capability: 'fixture.resource',
      target: 'agent',
      scopeId: 'installation:fixture:agent:manager',
      contractVersion: '1.0.0',
      artifact: { package: '@fixture/provider', version: '1.0.0', integrity: this.hash },
      executableDigest: this.hash,
    };
  }
  static resource(key = 'root'): SeedResourcePlan {
    return SeedSchemas.resourcePlan.parse({
      key,
      kind: 'fixture.resource',
      schema: { id: 'fixture.schema', version: '1.0.0', digest: this.hash },
      requires: ['fixture.resource'],
      dependsOn: [],
      providerRequirement: 'fixture.resource',
      provider: this.provider(),
      owner: 'agent',
      configurationDigest: this.hash,
      desiredDigest: this.hash,
      expectedGeneration: null,
      desiredGeneration: null,
      previousRecord: null,
      effects: [{ kind: 'fixture.prepare', target: key }],
    });
  }
  static plan(directory: string, installationId: string): SeedPlan {
    const content = {
      schemaVersion: 'treeseed.seed-plan/v1',
      seedDigest: this.hash,
      binding: {
        installationId,
        installationDirectory: directory,
        project: 'fixture-project',
        profile: 'default',
        principalId: 'subject:fixture',
        resourceScope: installationId,
        grantId: 'grant:fixture',
        grantRevision: 1,
      },
      locks: [this.lock()],
      resources: [this.resource()],
      blockers: [],
    };
    const digest = CanonicalJson.digest(content);
    return SeedSchemas.plan.parse({ ...content, id: 'seed-plan-' + digest, digest });
  }
  static lock(): SeedPlan['locks'][number] {
    const source = '@fixture/provider@1.0.0';
    return SeedSchemas.lock.parse({
      requirement: 'fixture.resource',
      provider: this.provider(),
      closureDigest: this.hash,
      source,
      receipt: {
        kind: 'npm',
        locator: source,
        name: '@fixture/provider',
        version: '1.0.0',
        archiveDigest: this.hash,
        closureDigest: this.hash,
        helperDigests: [this.hash],
        sri: 'sha256-' + Buffer.from(this.hash, 'hex').toString('base64'),
        registry: 'https://registry.example.invalid',
      },
    });
  }
  static nearLimitPlan(directory: string, installationId: string): SeedPlan {
    const plan = this.plan(directory, installationId);
    plan.resources = [];
    for (let index = 0; index < 16; index++) {
      const resource = this.resource('resource-' + index);
      resource.effects = [];
      for (let effect = 0; effect < 100; effect++) resource.effects.push({ kind: 'fixture.prepare', target: 'x' });
      plan.resources.push(resource);
    }
    let remaining = 256 * 1024 - 16 - Buffer.byteLength(CanonicalJson.stringify(plan));
    for (const resource of plan.resources) for (const effect of resource.effects) {
      const amount = Math.min(127, remaining);
      effect.target += 'x'.repeat(amount);
      remaining -= amount;
    }
    assert.equal(remaining, 0);
    const { id: _id, digest: _digest, ...content } = plan;
    plan.digest = CanonicalJson.digest(content);
    plan.id = 'seed-plan-' + plan.digest;
    return SeedSchemas.plan.parse(plan);
  }
  static receipt(plan: SeedPlan, requestId = 'fixture-request'): SeedReceipt {
    const resource = plan.resources[0]!;
    return SeedSchemas.receipt.parse({
      schemaVersion: 'treeseed.seed-receipt/v1',
      requestId,
      planId: plan.id,
      planDigest: plan.digest,
      binding: plan.binding,
      state: 'completed',
      expectedResources: plan.resources,
      resources: [this.resourceReceipt(resource)],
      blockers: [],
    });
  }
  static resourceReceipt(resource: SeedResourcePlan) {
    return {
      key: resource.key,
      provider: resource.provider,
      desiredDigest: resource.desiredDigest,
      state: 'verified',
      owner: resource.owner,
      record: 'fixture-record:' + resource.key,
      observedDigest: resource.desiredDigest,
      generation: resource.desiredGeneration,
      blockers: [],
    };
  }
  async prepare(): Promise<void> {
    await this.release.services();
    const deployment = await new ComposeDeploymentHost().plan(this.release.configuration);
    this.plan = SeedJournalFixture.plan(
      this.release.installation,
      deployment.configuration.installationId,
    );
    await this.open();
  }
  async open(): Promise<void> {
    this.root = await SeedJournalFixture.type().start({
      scopeId: 'api:' + this.plan.binding.installationId,
      target: 'api',
      principalId: this.plan.binding.principalId,
      resourceScope: this.plan.binding.resourceScope,
    });
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
    try {
      await this.root?.close();
    } finally {
      this.release.close();
    }
  }
  async restartWithoutBundle(): Promise<void> {
    await this.root?.close();
    this.root = null;
    rmSync(this.release.bundle, { recursive: true });
    await this.open();
  }
}

/** Faults occur after the genuine owner operation; all filesystem bytes remain real. */
export class SeedJournalReplyFault {
  private static readonly append = InstallationRecords.prototype.append;
  private static readonly close = InstallationRecords.prototype.close;
  static installReply(): void {
    InstallationRecords.prototype.append = this.prototype.lostReply;
  }
  static installClose(): void {
    InstallationRecords.prototype.close = this.prototype.failedClose;
  }
  static restore(): void {
    InstallationRecords.prototype.append = this.append;
    InstallationRecords.prototype.close = this.close;
  }
  async lostReply(
    this: InstallationRecords,
    head: string | null,
    content: unknown,
  ): Promise<InstallationRecord> {
    const record = await SeedJournalReplyFault.append.call(this, head, content);
    if (Reflect.get(content as object, 'kind') === 'receipt')
      throw new Error('PRIVATE_REPLY_CANARY');
    return record;
  }
  failedClose(this: InstallationRecords): void {
    SeedJournalReplyFault.close.call(this);
    throw new Error('PRIVATE_CLOSE_CANARY');
  }
}
