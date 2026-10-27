# Owner testing strategy


All permanent executable test specifications MUST live in the owning repository under exactly
these tier directories, named for the capability or behavior being verified:

- `tests/acceptance/`: user-observable flows, end-to-end/browser coverage and smoke tests of built programs.
- `tests/regression/`: cases that pin an identified prior defect and prevent recurrence.
- `tests/integration/`: real collaborator, provider, package, filesystem and service boundaries.
- `tests/unit/`: isolated contracts, computations and transformations.

Write tests outside-in in that order, after committing documentation and before implementation.
Split mixed-tier suites. A negative case is classified by its purpose and boundary; it is not
automatically a regression. Permanent test files MUST NOT be flat under `tests/`, colocated with
source, or named after a migration/task/phase number. Do not disguise test suites as helpers.
Shared fixture classes, fixture programs and data may use `tests/support/`, with no test
registrations there. Historical migration evidence, exact composition pins and immutable archives
retain provenance outside executable test suites; durable coverage moves into the proper tier.

Every reorganization preserves assertions, inputs, timeouts, negative cases and discovery/count
parity. Update imports, fixture/build entrypoints, public test-helper exports, package scripts,
partition inventories, CI and current docs together. Verify all four tiers are discovered; an
empty tier must be recorded honestly rather than filled with redundant tests or silently skipped.
Include an executable layout/discovery check in the normal owner verification and CI gates;
exercise rejection of misplaced tests, phase-based names and hidden helper registrations.
For a setup-only repository, install that check with its first implementation, without adding
application scaffolding or dependencies during initialization.

Every injectable seam still needs default production construction coverage, and every user
program needs a built-program acceptance test. Completion requires applicable tier suites,
checks, build, CI and assembled-artifact smoke evidence. Report missing prerequisites or gates
explicitly. A green unit suite or policy prose alone is never sufficient.


