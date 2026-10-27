import { expect, test } from 'bun:test';
import { SeedPlanIdentity, SeedResourceOrder } from '../../src/seed-reconciliation.js';
import { SeedData } from '../support/seed-reconciliation-program.js';

class SeedReconciliationContracts {
  validPlan(): void {
    const plan = SeedData.plan();
    expect(SeedPlanIdentity.read(plan)).toEqual(plan);
  }
  tamperedDigest(): void {
    const plan = SeedData.plan();
    plan.resources[0]!.configurationDigest = 'b'.repeat(64);
    expect(SeedPlanIdentity.read.bind(SeedPlanIdentity, plan)).toThrow('SEED_PLAN_INVALID');
  }
  invalidGraph(): void {
    const plan = SeedData.plan();
    plan.resources[0]!.dependsOn = ['missing'];
    expect(SeedPlanIdentity.read.bind(SeedPlanIdentity, plan)).toThrow('SEED_PLAN_INVALID');
  }
  order(): void {
    const resources = [SeedData.resource('c', ['a']), SeedData.resource('b'), SeedData.resource('a')];
    expect(SeedResourceOrder.sort(resources)).toEqual([resources[2]!, resources[1]!, resources[0]!]);
  }
}

const suite = new SeedReconciliationContracts();
test('unit: seed saved plan verifies its canonical content digest', suite.validPlan.bind(suite));
test('unit: seed saved plan rejects tampering despite unchanged identity fields', suite.tamperedDigest.bind(suite));
test('unit: seed saved plan rejects invalid resource graphs', suite.invalidGraph.bind(suite));
test('unit: seed resource order is deterministic across ready siblings', suite.order.bind(suite));
