import { expect, test } from "vite-plus/test";
import {
  FULL_PATH_EXPECTED_CHECKSUM,
  FULL_PATH_FIXTURE,
  FULL_PATH_OPERATIONS,
  runFullPathScenario,
} from "./full-path-scenario";

test("the full-path issue-tracker scenario preserves its workload and result", async () => {
  expect(FULL_PATH_FIXTURE.counts).toEqual({
    members: 12,
    projects: 4,
    tasks: 60,
    comments: 100,
    activityEvents: 40,
    total: 216,
  });
  expect(FULL_PATH_FIXTURE.serializedBytes).toBeGreaterThan(150 * 1_024);
  expect(FULL_PATH_OPERATIONS).toEqual({
    directGets: 2,
    indexedLists: 2,
    listAllExpectedPages: 4,
    actionInvocations: 8,
    batchedReads: 12,
    invalidRequests: 1,
    deniedRequests: 1,
    protocolRequests: 3,
    responseEnvelopes: 2,
  });

  const report = await runFullPathScenario();

  expect(report.finalCounts).toEqual({
    members: 12,
    projects: 4,
    tasks: 61,
    comments: 101,
    activityEvents: 46,
  });
  expect(report.indexedTaskIds).toEqual(["task-01", "task-13", "task-25", "task-37", "task-49"]);
  expect(report.assigneeTaskIds).toEqual(["task-49", "task-37", "task-25", "task-13", "task-01"]);
  expect(report.listAllPages).toBe(4);
  expect(report.batchTaskIds).toEqual(
    Array.from({ length: 12 }, (_, index) => `task-${String(index + 1).padStart(2, "0")}`),
  );
  expect(report.sideEffects).toEqual({
    assignedTo: "member-03",
    finalStatus: "TODO",
    createdTaskId: "task-benchmark-action",
    createdCommentId: "comment-benchmark-action",
    projectActivityCount: 11,
    workspaceTasks: 62,
    backlogCount: 12,
  });
  expect(report.failures).toEqual({
    stale: "STALE_WRITE",
    validation: "VALIDATION",
    policy: "FORBIDDEN",
    policyReason: "EDITOR_REQUIRED",
  });
  expect(report.protocol).toEqual({
    requestCount: 3,
    encodedBytes: 587,
    responsesValidated: 2,
  });
  expect(report.checksum).toBe(FULL_PATH_EXPECTED_CHECKSUM);
}, 30_000);
