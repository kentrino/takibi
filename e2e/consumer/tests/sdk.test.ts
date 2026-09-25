import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FULL_PATH_EXPECTED_CHECKSUM,
  FULL_PATH_FIXTURE,
  FULL_PATH_OPERATIONS,
  runFullPathScenario,
} from "@takibi/issue-tracker";

test("takibi runs the issue-tracker scenario", { timeout: 30_000 }, async () => {
  assert.deepEqual(FULL_PATH_FIXTURE.counts, {
    members: 12,
    projects: 4,
    tasks: 60,
    comments: 100,
    activityEvents: 40,
    total: 216,
  });
  assert.deepEqual(FULL_PATH_OPERATIONS, {
    directGets: 2,
    indexedLists: 2,
    listAllExpectedPages: 4,
    actionInvocations: 8,
    batchedReads: 12,
    invalidRequests: 1,
    deniedRequests: 1,
  });

  const report = await runFullPathScenario();
  assert.deepEqual(report.finalCounts, {
    members: 12,
    projects: 4,
    tasks: 61,
    comments: 101,
    activityEvents: 46,
  });
  assert.equal(report.checksum, FULL_PATH_EXPECTED_CHECKSUM);
});
