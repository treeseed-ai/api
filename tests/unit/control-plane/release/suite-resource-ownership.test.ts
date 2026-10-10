import { expect, it } from 'vitest';
import configuration from '../../../../vitest.control-plane.config.ts';

it('retains every owning test and original bounds while native archive installation has exclusive file ownership', () => {
 const test = configuration.test!;
 expect(test.include).toEqual(['tests/unit/control-plane/**/*.test.ts']);
 expect(test.testTimeout).toBe(30_000); expect(test.maxWorkers).toBe(2);
 expect(test.fileParallelism).toBe(true);
 expect(test.projects).toHaveLength(2);
 const [archive, rest] = test.projects as Array<{extends:boolean;test:{name:string;include?:string[];exclude?:string[];fileParallelism?:boolean;sequence:{groupOrder:number}}}>;
 expect(archive!.extends).toBe(true); expect(rest!.extends).toBe(true);
 expect(archive!.test.include).toEqual(['tests/unit/control-plane/release/installed-assets.test.ts']);
 expect(archive!.test.fileParallelism).toBe(false);
 expect(archive!.test.sequence.groupOrder).toBeLessThan(rest!.test.sequence.groupOrder);
 expect(rest!.test.exclude).toContain(archive!.test.include![0]);
 expect(new Set([archive!.test.name,rest!.test.name]).size).toBe(2);
});
