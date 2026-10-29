import {
  CanonicalJson,
  SeedContractBinding,
  SeedSchemas,
  type SeedBinding,
  type SeedPlan,
  type SeedReceipt,
  type SeedResourceContext,
  type SeedResourcePlan,
  type SeedResourceReceipt,
} from '@treeseed-cordis/sdk';

export interface SeedAuthority {
  assert(binding: SeedBinding, signal: AbortSignal): Promise<void>;
}
export interface SeedOwnerLease {
  admit(context: SeedResourceContext, retry: boolean): Promise<void>;
  reconcile(context: SeedResourceContext): Promise<unknown>;
  readBack(receipt: SeedResourceReceipt, context: SeedResourceContext): Promise<unknown>;
  close(): Promise<void>;
}
export interface SeedOwnerAccess {
  acquire(resource: SeedResourcePlan, context: SeedResourceContext): Promise<SeedOwnerLease>;
}
export interface SeedProgress {
  receipt: SeedReceipt | null;
  intents: string[];
}
export interface SeedWriter {
  read(): Promise<SeedProgress>;
  intent(resource: SeedResourcePlan): Promise<void>;
  publish(receipt: SeedReceipt): Promise<unknown>;
  close(): Promise<void>;
}
export interface SeedJournal {
  acquire(plan: SeedPlan, requestId: string, signal: AbortSignal): Promise<SeedWriter>;
}

type SeedFailureCode =
  | 'SEED_PLAN_INVALID'
  | 'SEED_REQUEST_INVALID'
  | 'SEED_CANCELLED'
  | 'SEED_AUTHORITY_BLOCKED'
  | 'SEED_OWNER_BLOCKED'
  | 'SEED_JOURNAL_FAILED';
export class SeedReconciliationError extends Error {
  constructor(readonly code: SeedFailureCode) {
    super(code);
    this.name = 'SeedReconciliationError';
  }
}

export class SeedPlanIdentity {
  static read(input: unknown): SeedPlan {
    const parsed = SeedSchemas.plan.safeParse(input);
    if (!parsed.success) throw new SeedReconciliationError('SEED_PLAN_INVALID');
    const { id, digest, ...content } = parsed.data;
    if (id !== 'seed-plan-' + digest || CanonicalJson.digest(content) !== digest)
      throw new SeedReconciliationError('SEED_PLAN_INVALID');
    return parsed.data;
  }
}

export class SeedResourceOrder {
  static compare(left: SeedResourcePlan, right: SeedResourcePlan): number {
    return left.key < right.key ? -1 : left.key > right.key ? 1 : 0;
  }
  static sort(resources: SeedResourcePlan[]): SeedResourcePlan[] {
    const remaining = [...resources].sort(this.compare);
    const result: SeedResourcePlan[] = [];
    const done = new Set<string>();
    while (remaining.length) {
      const next = this.next(remaining, done);
      if (next < 0) throw new SeedReconciliationError('SEED_PLAN_INVALID');
      const resource = remaining.splice(next, 1)[0]!;
      result.push(resource);
      done.add(resource.key);
    }
    return result;
  }
  private static next(resources: SeedResourcePlan[], done: Set<string>): number {
    for (let index = 0; index < resources.length; index++) {
      let ready = true;
      for (const key of resources[index]!.dependsOn) if (!done.has(key)) ready = false;
      if (ready) return index;
    }
    return -1;
  }
}

class SeedAuthorityAdmission {
  constructor(private readonly authority: SeedAuthority) {}
  async assert(binding: SeedBinding, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new SeedReconciliationError('SEED_CANCELLED');
    try {
      await this.authority.assert(structuredClone(binding), signal);
    } catch {
      throw new SeedReconciliationError('SEED_AUTHORITY_BLOCKED');
    }
    if (signal.aborted) throw new SeedReconciliationError('SEED_CANCELLED');
  }
}

class SeedEvidence {
  static read(resource: SeedResourcePlan, input: unknown): SeedResourceReceipt {
    const receipt = SeedContractBinding.assertResource(resource, input);
    if (receipt.state !== 'verified') receipt.blockers = this.blockers(receipt.state);
    return receipt;
  }
  static blockers(state: SeedResourceReceipt['state']): SeedResourceReceipt['blockers'] {
    if (state === 'verified') return [];
    return [
      {
        code: 'SEED_OWNER_' + state.toUpperCase().replaceAll('-', '_'),
        message: 'The owner step has not been verified.',
      },
    ];
  }
  static recovery(resource: SeedResourcePlan): SeedResourceReceipt {
    return SeedSchemas.resourceReceipt.parse({
      key: resource.key,
      provider: resource.provider,
      desiredDigest: resource.desiredDigest,
      owner: resource.owner,
      state: 'recovery-required',
      record: null,
      observedDigest: null,
      generation: resource.desiredGeneration,
      blockers: this.blockers('recovery-required'),
    });
  }
}

class SeedReceiptBuilder {
  static state(resources: SeedResourceReceipt[], count: number): SeedReceipt['state'] {
    const states = new Set<string>();
    for (const resource of resources) states.add(resource.state);
    if (states.has('recovery-required')) return 'recovery-required';
    if (states.size === 1 && states.has('verified') && resources.length === count)
      return 'completed';
    if (states.has('verified')) return 'partial';
    if (states.has('blocked')) return 'blocked';
    return 'pending';
  }
  static create(plan: SeedPlan, requestId: string, resources: SeedResourceReceipt[]): SeedReceipt {
    const state = this.state(resources, plan.resources.length);
    return SeedSchemas.receipt.parse({
      schemaVersion: 'treeseed.seed-receipt/v1',
      requestId,
      planId: plan.id,
      planDigest: plan.digest,
      binding: plan.binding,
      expectedResources: plan.resources,
      resources,
      state,
      blockers:
        state === 'completed'
          ? []
          : [
              {
                code: 'SEED_RECONCILIATION_INCOMPLETE',
                message: 'Not every owner step has been verified.',
              },
            ],
    });
  }
}

class SeedResume {
  readonly receipts = new Map<string, SeedResourceReceipt>();
  readonly intents = new Set<string>();
  constructor(
    private readonly plan: SeedPlan,
    private readonly requestId: string,
  ) {}
  load(progress: SeedProgress): void {
    if (!Array.isArray(progress.intents)) throw new Error('Invalid seed intents');
    const keys = new Set<string>();
    for (const resource of this.plan.resources) keys.add(resource.key);
    for (const key of progress.intents) {
      if (!keys.has(key) || this.intents.has(key)) throw new Error('Invalid seed intent');
      this.intents.add(key);
    }
    if (progress.receipt !== null) this.saved(progress.receipt);
  }
  private saved(input: unknown): void {
    const receipt = SeedContractBinding.assertReceipt(input, this.plan);
    if (receipt.requestId !== this.requestId) throw new Error('Invalid seed request');
    for (const resource of receipt.resources) {
      if (!this.intents.has(resource.key)) throw new Error('Missing seed intent');
      this.receipts.set(resource.key, resource);
    }
  }
}

class SeedOwnerStep {
  constructor(
    private readonly authority: SeedAuthorityAdmission,
    private readonly owners: SeedOwnerAccess,
    private readonly writer: SeedWriter,
    private readonly plan: SeedPlan,
    private readonly requestId: string,
    private readonly signal: AbortSignal,
  ) {}

  private context(): SeedResourceContext {
    return {
      binding: structuredClone(this.plan.binding),
      requestId: this.requestId,
      signal: this.signal,
    };
  }
  async run(resource: SeedResourcePlan, resume: SeedResume): Promise<SeedResourceReceipt> {
    await this.authority.assert(this.plan.binding, this.signal);
    const owner = await this.owners.acquire(structuredClone(resource), this.context());
    try {
      await owner.admit(this.context(), resume.intents.has(resource.key));
      const saved = resume.receipts.get(resource.key);
      if (saved?.state === 'verified') return await this.readBack(owner, resource, saved);
      return await this.reconcile(owner, resource, resume);
    } finally {
      await owner.close();
    }
  }
  async verify(
    resource: SeedResourcePlan,
    receipt: SeedResourceReceipt,
  ): Promise<SeedResourceReceipt> {
    await this.authority.assert(this.plan.binding, this.signal);
    const owner = await this.owners.acquire(structuredClone(resource), this.context());
    try {
      await owner.admit(this.context(), true);
      return await this.readBack(owner, resource, receipt);
    } finally {
      await owner.close();
    }
  }
  private async reconcile(
    owner: SeedOwnerLease,
    resource: SeedResourcePlan,
    resume: SeedResume,
  ): Promise<SeedResourceReceipt> {
    await this.authority.assert(this.plan.binding, this.signal);
    await this.intent(resource, resume);
    await this.authority.assert(this.plan.binding, this.signal);
    const receipt = SeedEvidence.read(resource, await owner.reconcile(this.context()));
    if (receipt.state !== 'verified') return receipt;
    return this.readBack(owner, resource, receipt);
  }
  private async intent(resource: SeedResourcePlan, resume: SeedResume): Promise<void> {
    try {
      await this.writer.intent(structuredClone(resource));
    } catch {
      throw new SeedReconciliationError('SEED_JOURNAL_FAILED');
    }
    resume.intents.add(resource.key);
  }
  private async readBack(
    owner: SeedOwnerLease,
    resource: SeedResourcePlan,
    receipt: SeedResourceReceipt,
  ): Promise<SeedResourceReceipt> {
    await this.authority.assert(this.plan.binding, this.signal);
    return SeedEvidence.read(
      resource,
      await owner.readBack(structuredClone(receipt), this.context()),
    );
  }
}

class SeedApplySession {
  private readonly resume: SeedResume;
  private readonly step: SeedOwnerStep;
  private readonly observations: SeedResourceReceipt[] = [];
  constructor(
    private readonly plan: SeedPlan,
    private readonly requestId: string,
    private readonly writer: SeedWriter,
    authority: SeedAuthorityAdmission,
    owners: SeedOwnerAccess,
    signal: AbortSignal,
  ) {
    this.resume = new SeedResume(plan, requestId);
    this.step = new SeedOwnerStep(authority, owners, writer, plan, requestId, signal);
  }
  async run(): Promise<SeedReceipt> {
    this.resume.load(await this.writer.read());
    let receipt = SeedReceiptBuilder.create(this.plan, this.requestId, []);
    for (const resource of SeedResourceOrder.sort(this.plan.resources)) {
      const observed = await this.observe(resource);
      this.observations.push(observed);
      receipt = await this.publish();
      if (observed.state !== 'verified') break;
    }
    return receipt;
  }
  private async observe(resource: SeedResourcePlan): Promise<SeedResourceReceipt> {
    try {
      return await this.step.run(resource, this.resume);
    } catch (error) {
      if (error instanceof SeedReconciliationError) throw error;
      if (!this.resume.intents.has(resource.key))
        throw new SeedReconciliationError('SEED_OWNER_BLOCKED');
      return SeedEvidence.recovery(resource);
    }
  }
  private async publish(): Promise<SeedReceipt> {
    if (this.observations.length === this.plan.resources.length) await this.refresh();
    const receipt = SeedReceiptBuilder.create(this.plan, this.requestId, this.observations);
    const saved = SeedContractBinding.assertReceipt(
      await this.writer.publish(structuredClone(receipt)),
      this.plan,
    );
    if (CanonicalJson.stringify(saved) !== CanonicalJson.stringify(receipt))
      throw new Error('Seed read-back failed');
    return saved;
  }
  private async refresh(): Promise<void> {
    const resources = SeedResourceOrder.sort(this.plan.resources);
    for (const [index, resource] of resources.entries()) {
      const observed = this.observations[index]!;
      if (observed.state !== 'verified') continue;
      try {
        this.observations[index] = await this.step.verify(resource, observed);
      } catch (error) {
        if (error instanceof SeedReconciliationError) throw error;
        this.observations[index] = SeedEvidence.recovery(resource);
      }
    }
  }
}

/** Internal sequencing capability. Native default adapters and public entrypoint are separate gates. */
export class SeedReconciliation {
  private readonly admission: SeedAuthorityAdmission;
  constructor(
    authority: SeedAuthority,
    private readonly owners: SeedOwnerAccess,
    private readonly journal: SeedJournal,
  ) {
    this.admission = new SeedAuthorityAdmission(authority);
  }

  async apply(input: unknown, requestId: string, signal: AbortSignal): Promise<SeedReceipt> {
    const plan = SeedPlanIdentity.read(input);
    if (!SeedSchemas.key.safeParse(requestId).success)
      throw new SeedReconciliationError('SEED_REQUEST_INVALID');
    await this.admission.assert(plan.binding, signal);
    try {
      return await this.written(plan, requestId, signal);
    } catch (error) {
      if (error instanceof SeedReconciliationError) throw error;
      throw new SeedReconciliationError('SEED_JOURNAL_FAILED');
    }
  }
  private async written(
    plan: SeedPlan,
    requestId: string,
    signal: AbortSignal,
  ): Promise<SeedReceipt> {
    const writer = await this.journal.acquire(structuredClone(plan), requestId, signal);
    try {
      return await new SeedApplySession(
        plan,
        requestId,
        writer,
        this.admission,
        this.owners,
        signal,
      ).run();
    } finally {
      await writer.close();
    }
  }
}
