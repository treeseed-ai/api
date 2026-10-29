import assert from 'node:assert/strict';
import {
  CanonicalJson,
  SeedSchemas,
  type SeedBinding,
  type SeedPlan,
  type SeedReceipt,
  type SeedResourceContext,
  type SeedResourcePlan,
  type SeedResourceReceipt,
} from '@treeseed-cordis/sdk';
import {
  SeedReconciliation,
  type SeedJournal,
  type SeedWriter,
  type SeedProgress,
  type SeedAuthority,
  type SeedOwnerAccess,
  type SeedOwnerLease,
} from '../../src/seed-reconciliation.js';

/** Synthetic contract identities only; these fixtures never represent accepted package artifacts. */
export class SeedData {
  static readonly hash = 'a'.repeat(64);
  static readonly provider = {
    id: 'fixture.provider',
    capability: 'fixture.resource',
    target: 'agent',
    scopeId: 'installation:fixture:agent:manager',
    contractVersion: '1.0.0',
    artifact: { package: '@fixture/provider', version: '1.0.0', integrity: this.hash },
    executableDigest: this.hash,
  };
  static readonly binding = {
    installationId: 'installation:fixture',
    installationDirectory: '/fixture/installation',
    project: 'fixture-project',
    profile: 'default',
    principalId: 'subject:fixture',
    resourceScope: 'installation:fixture',
    grantId: 'grant:fixture',
    grantRevision: 1,
  };

  static resource(key: string, dependsOn: string[] = []): SeedResourcePlan {
    return SeedSchemas.resourcePlan.parse({
      key,
      kind: 'fixture.resource',
      schema: { id: 'fixture.schema', version: '1.0.0', digest: this.hash },
      requires: ['fixture.resource'],
      dependsOn,
      providerRequirement: 'fixture.resource',
      provider: this.provider,
      owner: 'agent',
      configurationDigest: this.hash,
      desiredDigest: this.hash,
      expectedGeneration: null,
      desiredGeneration: null,
      previousRecord: null,
      effects: [{ kind: 'fixture.prepare', target: key }],
    });
  }

  static lock(): SeedPlan['locks'][number] {
    const source = '@fixture/provider@1.0.0';
    return SeedSchemas.lock.parse({
      requirement: 'fixture.resource',
      provider: this.provider,
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

  static plan(resources = [this.resource('root')]): SeedPlan {
    const content = {
      schemaVersion: 'treeseed.seed-plan/v1',
      seedDigest: this.hash,
      binding: this.binding,
      locks: [this.lock()],
      resources,
      blockers: [],
    };
    const digest = CanonicalJson.digest(content);
    return SeedSchemas.plan.parse({ ...content, id: 'seed-plan-' + digest, digest });
  }

  static receipt(resource: SeedResourcePlan): SeedResourceReceipt {
    return SeedSchemas.resourceReceipt.parse({
      key: resource.key,
      provider: resource.provider,
      desiredDigest: resource.desiredDigest,
      state: 'verified',
      owner: resource.owner,
      record: 'fixture-record:' + resource.key,
      observedDigest: resource.desiredDigest,
      generation: resource.desiredGeneration,
      blockers: [],
    });
  }
}

export class FixtureAuthority implements SeedAuthority {
  allowed = true;
  async assert(binding: SeedBinding, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    assert.equal(binding.principalId, SeedData.binding.principalId);
    if (!this.allowed) throw new Error('private-authority-canary');
  }
}

export class FixtureJournal implements SeedJournal {
  progress: SeedProgress = { receipt: null, intents: [] };
  events: string[] = [];
  locked = false;
  failPublication = false;
  failIntent = false;
  mismatchPublication = false;
  failClose = false;
  request: string | null = null;

  async acquire(plan: SeedPlan, requestId: string, signal: AbortSignal): Promise<SeedWriter> {
    signal.throwIfAborted();
    if (this.locked) throw new Error('writer-conflict');
    if (this.request !== null && this.request !== requestId) throw new Error('request-conflict');
    this.request = requestId;
    this.locked = true;
    this.events.push('writer:' + plan.id);
    return new FixtureWriter(this);
  }
}

class FixtureWriter implements SeedWriter {
  constructor(private readonly journal: FixtureJournal) {}
  async read(): Promise<SeedProgress> {
    return structuredClone(this.journal.progress);
  }
  async intent(resource: SeedResourcePlan): Promise<void> {
    if (this.journal.failIntent) throw new Error('private-intent-canary');
    this.journal.events.push('intent:' + resource.key);
    if (!this.journal.progress.intents.includes(resource.key))
      this.journal.progress.intents.push(resource.key);
  }
  async publish(receipt: SeedReceipt): Promise<unknown> {
    this.journal.events.push('publish:' + receipt.state);
    if (this.journal.failPublication) throw new Error('private-publication-canary');
    this.journal.progress.receipt = structuredClone(receipt);
    if (this.journal.mismatchPublication) return { ...receipt, requestId: 'foreign:request' };
    return structuredClone(receipt);
  }
  async close(): Promise<void> {
    this.journal.locked = false;
    if (this.journal.failClose) throw new Error('writer-disposal-failed');
  }
}

export class FixtureOwners implements SeedOwnerAccess {
  readonly records = new Map<string, SeedResourceReceipt>();
  readonly effects: string[] = [];
  loseReply = false;
  pending = false;
  changed = false;
  changedKey: string | null = null;
  failClose = false;
  failAdmission = false;
  beforeEffect: (() => void) | null = null;

  constructor(readonly journal: FixtureJournal) {}
  async acquire(resource: SeedResourcePlan, context: SeedResourceContext): Promise<SeedOwnerLease> {
    context.signal.throwIfAborted();
    this.journal.events.push('owner:' + resource.key);
    return new FixtureOwnerLease(this, resource);
  }
}

class FixtureOwnerLease implements SeedOwnerLease {
  constructor(
    private readonly owner: FixtureOwners,
    private readonly resource: SeedResourcePlan,
  ) {}
  async admit(context: SeedResourceContext, retry: boolean): Promise<void> {
    context.signal.throwIfAborted();
    if (this.owner.failAdmission) throw new Error('private-admission-canary');
    this.owner.journal.events.push('admit:' + this.resource.key + ':' + retry);
  }
  async reconcile(context: SeedResourceContext): Promise<unknown> {
    this.owner.beforeEffect?.();
    const key = context.requestId + ':' + this.resource.key;
    const previous = this.owner.records.get(key);
    if (previous) return previous;
    assert(this.owner.journal.progress.intents.includes(this.resource.key));
    this.owner.effects.push(this.resource.key);
    const receipt = this.next();
    this.owner.records.set(key, receipt);
    if (this.owner.loseReply) {
      this.owner.loseReply = false;
      throw new Error('private-owner-secret-canary');
    }
    return receipt;
  }
  private next(): SeedResourceReceipt {
    const receipt = SeedData.receipt(this.resource);
    return this.owner.pending
      ? { ...receipt, state: 'pending', record: null, observedDigest: null }
      : receipt;
  }
  async readBack(receipt: SeedResourceReceipt, context: SeedResourceContext): Promise<unknown> {
    context.signal.throwIfAborted();
    this.owner.journal.events.push('read:' + this.resource.key);
    const changed = this.owner.changed || this.owner.changedKey === this.resource.key;
    return changed ? { ...receipt, observedDigest: 'b'.repeat(64) } : receipt;
  }
  async close(): Promise<void> {
    this.owner.journal.events.push('owner-close:' + this.resource.key);
    if (this.owner.failClose) throw new Error('owner-disposal-failed');
  }
}

export class SeedFixture {
  readonly journal = new FixtureJournal();
  readonly authority = new FixtureAuthority();
  readonly owners = new FixtureOwners(this.journal);
  readonly engine = new SeedReconciliation(this.authority, this.owners, this.journal);
  readonly controller = new AbortController();
  apply(plan = SeedData.plan()): Promise<SeedReceipt> {
    return this.engine.apply(plan, 'request:fixture', this.controller.signal);
  }
}

class ReconciliationProgram {
  async lateChange(): Promise<void> {
    const fixture = new SeedFixture();
    fixture.owners.beforeEffect = this.invalidate.bind(this, fixture);
    const plan = SeedData.plan([SeedData.resource('child', ['root']), SeedData.resource('root')]);
    const result = await fixture.apply(plan);
    assert.equal(result.state, 'recovery-required');
    assert(!fixture.journal.events.includes('publish:completed'));
    assert.deepEqual(fixture.owners.effects, ['root', 'child']);
    assert.equal(fixture.journal.locked, false);
    process.stdout.write('seed-late-owner-change-fixture-ok\n');
  }
  private invalidate(fixture: SeedFixture): void {
    if (fixture.owners.effects.includes('root')) fixture.owners.changedKey = 'root';
  }
  async run(): Promise<void> {
    const fixture = new SeedFixture();
    fixture.owners.loseReply = true;
    assert.equal((await fixture.apply()).state, 'recovery-required');
    const result = await fixture.apply();
    assert.equal(result.state, 'completed');
    assert.deepEqual(fixture.owners.effects, ['root']);
    assert.equal(result.resources[0]?.record, 'fixture-record:root');
    assert.equal(fixture.journal.locked, false);
    process.stdout.write('seed-reconciliation-fixture-ok\n');
  }
}

if (import.meta.main) {
  const program = new ReconciliationProgram();
  if (process.argv[2] === 'late-change') await program.lateChange();
  else await program.run();
}
