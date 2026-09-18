import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FULL_PATH_EXPECTED_CHECKSUM,
  FULL_PATH_FIXTURE,
  FULL_PATH_OPERATIONS,
  runFullPathScenario,
} from "~/index.ts";

void test(
  "the issue-tracker scenario preserves its workload and result",
  { timeout: 30_000 },
  async () => {
    assert.deepEqual(FULL_PATH_FIXTURE.counts, {
      members: 12,
      projects: 4,
      tasks: 60,
      comments: 100,
      activityEvents: 40,
      total: 216,
    });
    assert.ok(FULL_PATH_FIXTURE.serializedBytes > 150 * 1_024);
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
    assert.deepEqual(report.indexedTaskIds, [
      "task-01",
      "task-13",
      "task-25",
      "task-37",
      "task-49",
    ]);
    assert.deepEqual(report.assigneeTaskIds, [
      "task-49",
      "task-37",
      "task-25",
      "task-13",
      "task-01",
    ]);
    assert.equal(report.listAllPages, 4);
    assert.deepEqual(
      report.batchTaskIds,
      Array.from({ length: 12 }, (_, index) => `task-${String(index + 1).padStart(2, "0")}`),
    );
    assert.deepEqual(report.sideEffects, {
      assignedTo: "member-03",
      finalStatus: "TODO",
      createdTaskId: "task-benchmark-action",
      createdCommentId: "comment-benchmark-action",
      projectActivityCount: 11,
      workspaceTasks: 62,
      backlogCount: 12,
    });
    assert.deepEqual(report.failures, {
      stale: "STALE_WRITE",
      validation: "VALIDATION",
      policy: "FORBIDDEN",
      policyReason: "EDITOR_REQUIRED",
    });
    assert.equal(report.checksum, FULL_PATH_EXPECTED_CHECKSUM);
  },
);
