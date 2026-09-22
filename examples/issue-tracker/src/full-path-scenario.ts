import assert from "node:assert/strict";
import { Hono } from "hono";
import { takibiServer } from "@takibi/hono-adapter";
import { type TakibiResult } from "takibi";
import { createClient } from "takibi/client";
import { withSqliteTestBackend } from "takibi/testing";
import {
  BATCH_READ_COUNT,
  createIssueTrackerHandler,
  EDITOR_ID,
  FIXTURE,
  FULL_PATH_FIXTURE,
  fixedText,
  headers,
  id,
  LIST_ALL_PAGE_SIZE,
  TENANT_ID,
  type BenchmarkContext,
  type TaskInput,
} from "./handler.ts";

export const FULL_PATH_OPERATIONS = {
  directGets: 2,
  indexedLists: 2,
  listAllExpectedPages: 4,
  actionInvocations: 8,
  batchedReads: BATCH_READ_COUNT,
  invalidRequests: 1,
  deniedRequests: 1,
} as const;

export const FULL_PATH_EXPECTED_CHECKSUM = 2_310_661_680;

function mustOk<T>(result: TakibiResult<T>, label: string): T {
  if (!result.ok) {
    assert.fail(`${label} failed with ${result.error.code}: ${result.error.message}`);
  }
  return result.data;
}

function mustFail<T>(result: TakibiResult<T>, code: string, label: string): void {
  assert.equal(result.ok, false, `${label} unexpectedly succeeded`);
  if (result.ok) return;
  assert.equal(result.error.code, code, `${label} returned ${result.error.code}, expected ${code}`);
}

function failureReasonCode<T>(result: TakibiResult<T>): string {
  if (result.ok || result.error.kind !== "operation" || !("reason" in result.error)) return "";
  const reason = result.error.reason as { code?: unknown } | undefined;
  return typeof reason?.code === "string" ? reason.code : "";
}

function checksum(parts: readonly string[]): number {
  let value = 2_166_136_261;
  for (const byte of new TextEncoder().encode(parts.join("|"))) {
    value ^= byte;
    value = Math.imul(value, 16_777_619);
  }
  return value >>> 0;
}

function benchmarkTask(overrides: Partial<TaskInput> = {}): TaskInput {
  return {
    tenantId: TENANT_ID,
    projectId: "project-01",
    key: "TASK-BENCH-NEW",
    title: "Task benchmark newly created lifecycle",
    description: fixedText("New benchmark task", 1_420),
    status: "TODO",
    priority: "HIGH",
    assigneeId: "member-02",
    reporterId: EDITOR_ID,
    watcherIds: ["member-03", "member-04"],
    labels: ["benchmark", "created"],
    dueDate: "2026-10-15",
    estimateMinutes: 180,
    rank: 1_001,
    checklist: Array.from({ length: 6 }, (_, index) => ({
      id: `new-check-${index + 1}`,
      text: `Complete benchmark creation step ${index + 1}`,
      done: false,
    })),
    customFields: {
      customer: "customer-new",
      impact: { score: 4, areas: ["runtime", "storage"] },
      release: { train: "2026.10", blocked: false },
    },
    commentCount: 0,
    audit: {
      source: "full-path-benchmark",
      importedBy: EDITOR_ID,
      checksumHint: "task-hint-new",
    },
    ...overrides,
  };
}

export type FullPathScenarioReport = {
  fixture: typeof FULL_PATH_FIXTURE;
  operations: typeof FULL_PATH_OPERATIONS;
  finalCounts: {
    members: number;
    projects: number;
    tasks: number;
    comments: number;
    activityEvents: number;
  };
  indexedTaskIds: string[];
  assigneeTaskIds: string[];
  listAllPages: number;
  batchTaskIds: string[];
  sideEffects: {
    assignedTo: string;
    finalStatus: string;
    createdTaskId: string;
    createdCommentId: string;
    projectActivityCount: number;
    workspaceTasks: number;
    backlogCount: number;
  };
  failures: { stale: string; validation: string; policy: string; policyReason: string };
  checksum: number;
};

export let fullPathBenchmarkSink = 0;

export async function runFullPathScenario(): Promise<FullPathScenarioReport> {
  const production = createIssueTrackerHandler();
  const handler = withSqliteTestBackend(production);
  const app = new Hono().route("/", takibiServer({ handler, createContext: () => ({}) }));
  const requestCounts = { list: 0, batch: 0 };
  const fetch = (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.pathname === "/_batch") requestCounts.batch += 1;
    if (request.method === "GET" && url.pathname === "/tasks") requestCounts.list += 1;
    return app.request(request);
  };
  const editorContext: BenchmarkContext = {
    tenantId: TENANT_ID,
    actorId: EDITOR_ID,
    role: "editor",
  };
  const viewerContext: BenchmarkContext = {
    tenantId: TENANT_ID,
    actorId: "member-12",
    role: "viewer",
  };

  try {
    const editor = createClient<typeof production>("http://takibi.benchmark", {
      headers: headers(editorContext),
      fetch,
    });
    const viewer = createClient<typeof production>("http://takibi.benchmark", {
      headers: headers(viewerContext),
      fetch,
    });
    const batched = createClient<typeof production>("http://takibi.benchmark", {
      headers: headers(editorContext),
      fetch,
      batch: { maxWaitMs: 0, maxSize: BATCH_READ_COUNT },
    });

    const firstMember = mustOk(await editor.members.get("member-01"), "seed initialization get");
    const firstProject = mustOk(await editor.projects.get("project-01"), "project get");
    assert.equal(firstMember.email, "member01@example.test");
    assert.equal(firstProject.key, "PRJ1");

    const indexed = mustOk(
      await editor.tasks.list({
        index: "byProjectStatusPriority",
        where: (query) =>
          query.and(
            query.tenantId.eq(TENANT_ID),
            query.projectId.eq("project-01"),
            query.status.eq("TODO"),
            query.priority.eq("URGENT"),
            query.title.contains("deterministic"),
          ),
        orderBy: (query) => query.rank.asc(),
        limit: 20,
      }),
      "project/status/priority indexed list",
    );
    const indexedTaskIds = indexed.items.map((task) => task.id);
    assert.deepEqual(indexedTaskIds, ["task-01", "task-13", "task-25", "task-37", "task-49"]);
    assert.equal(indexed.nextCursor, undefined);

    const assigned = mustOk(
      await editor.tasks.list({
        index: "byAssigneeOrder",
        where: (query) =>
          query.and(
            query.tenantId.eq(TENANT_ID),
            query.assigneeId.eq("member-01"),
            query.status.in(["TODO", "IN_PROGRESS"]),
          ),
        orderBy: (query) => query.rank.desc(),
        limit: 20,
      }),
      "assignee indexed list",
    );
    const assigneeTaskIds = assigned.items.map((task) => task.id);
    assert.deepEqual(assigneeTaskIds, ["task-49", "task-37", "task-25", "task-13", "task-01"]);

    const listRequestsBefore = requestCounts.list;
    const allTasks = mustOk(
      await editor.tasks.listAll({
        pageSize: LIST_ALL_PAGE_SIZE,
        where: (query) => query.tenantId.eq(TENANT_ID),
      }),
      "task listAll",
    );
    const listAllPages = requestCounts.list - listRequestsBefore;
    assert.equal(allTasks.length, 60);
    assert.equal(listAllPages, 4);

    const temporary = mustOk(
      await editor.tasks.add(benchmarkTask(), { id: "task-benchmark-temp" }),
      "direct task add",
    );
    const updatedTemporary = mustOk(
      await editor.tasks.update("task-benchmark-temp", {
        title: "Task benchmark updated lifecycle",
        rev: temporary.rev,
      }),
      "revision update",
    );
    assert.equal(updatedTemporary.rev, temporary.rev + 1);
    const stale = await editor.tasks.update("task-benchmark-temp", {
      title: "Task benchmark stale lifecycle",
      rev: temporary.rev,
    });
    mustFail(stale, "STALE_WRITE", "stale task update");

    const assign = mustOk(
      await editor.tasks.assign("task-02", {
        assignment: { assigneeId: "member-03", changedBy: EDITOR_ID },
        eventId: "activity-action-assign",
        sequence: 101,
      }),
      "assign action",
    );
    const reprioritized = mustOk(
      await editor.tasks.reprioritize("task-02", {
        priority: "URGENT",
        expectedRevision: assign.rev,
        eventId: "activity-action-priority",
        sequence: 102,
      }),
      "reprioritize action",
    );
    const completed = mustOk(
      await editor.tasks.complete("task-02", {
        eventId: "activity-action-complete",
        sequence: 103,
      }),
      "complete action",
    );
    assert.equal(completed.rev, reprioritized.rev + 1);
    const reopened = mustOk(
      await editor.tasks.reopen("task-02", {
        eventId: "activity-action-reopen",
        sequence: 104,
      }),
      "reopen action",
    );
    const createdByAction = mustOk(
      await editor.tasks.createWithInitialComment({
        task: benchmarkTask({
          key: "TASK-BENCH-ACTION",
          title: "Task benchmark created by detached action",
          commentCount: 1,
          rank: 1_002,
        }),
        taskId: "task-benchmark-action",
        comment: {
          tenantId: TENANT_ID,
          projectId: "project-01",
          taskId: "task-benchmark-action",
          authorId: EDITOR_ID,
          body: fixedText("Initial action comment", 760),
          mentions: ["member-02"],
          reactions: [{ emoji: "rocket", memberIds: [EDITOR_ID] }],
          sequence: 201,
          metadata: { source: "action", format: "plain-text", edited: false },
        },
        commentId: "comment-benchmark-action",
        eventId: "activity-action-create",
        sequence: 105,
      }),
      "detached create action",
    );
    const backlog = mustOk(
      await editor.tasks.backlogSummary({ projectId: "project-01" }),
      "backlog summary action",
    );
    const projectActivity = mustOk(
      await editor.recordProjectActivity({
        projectId: "project-01",
        taskId: "task-benchmark-action",
        eventId: "activity-action-root",
        sequence: 106,
        details: { channel: "benchmark", note: "Root atomic activity" },
      }),
      "root atomic action",
    );
    const workspace = mustOk(await editor.workspaceSummary(), "root summary action");

    const batchResults = await Promise.all(
      Array.from({ length: BATCH_READ_COUNT }, (_, index) => batched.tasks.get(id("task", index))),
    );
    assert.equal(requestCounts.batch, 1);
    const batchTaskIds = batchResults.map(
      (result, index) => mustOk(result, `batch item ${index}`).id,
    );
    assert.deepEqual(
      batchTaskIds,
      Array.from({ length: BATCH_READ_COUNT }, (_, index) => id("task", index)),
    );

    const invalid = await editor.tasks.add({
      ...benchmarkTask({ key: "TASK-BENCH-INVALID" }),
      title: "",
    });
    mustFail(invalid, "VALIDATION", "schema-invalid task");

    const denied = await viewer.tasks.createWithInitialComment({
      task: benchmarkTask({ key: "TASK-BENCH-DENIED" }),
      taskId: "task-benchmark-denied",
      comment: {
        ...FIXTURE.comments["comment-01"]!,
        taskId: "task-benchmark-denied",
        sequence: 202,
      },
      commentId: "comment-benchmark-denied",
      eventId: "activity-action-denied",
      sequence: 107,
    });
    mustFail(denied, "FORBIDDEN", "viewer action");
    assert.equal(failureReasonCode(denied), "EDITOR_REQUIRED");

    mustOk(await editor.tasks.delete("task-benchmark-temp"), "temporary task delete");
    const deleted = await editor.tasks.get("task-benchmark-temp");
    mustFail(deleted, "NOT_FOUND", "deleted task get");

    const finalCounts = {
      members: mustOk(
        await editor.members.listAll({ where: (query) => query.tenantId.eq(TENANT_ID) }),
        "final members",
      ).length,
      projects: mustOk(
        await editor.projects.listAll({ where: (query) => query.tenantId.eq(TENANT_ID) }),
        "final projects",
      ).length,
      tasks: mustOk(
        await editor.tasks.listAll({ where: (query) => query.tenantId.eq(TENANT_ID) }),
        "final tasks",
      ).length,
      comments: mustOk(
        await editor.comments.listAll({ where: (query) => query.tenantId.eq(TENANT_ID) }),
        "final comments",
      ).length,
      activityEvents: mustOk(
        await editor.activityEvents.listAll({ where: (query) => query.tenantId.eq(TENANT_ID) }),
        "final activity",
      ).length,
    };
    assert.deepEqual(finalCounts, {
      members: 12,
      projects: 4,
      tasks: 61,
      comments: 101,
      activityEvents: 46,
    });
    const changedTask = mustOk(await editor.tasks.get("task-02"), "changed task");
    assert.equal(changedTask.assigneeId, "member-03");
    assert.equal(changedTask.status, "TODO");
    mustOk(await editor.comments.get("comment-benchmark-action"), "action comment side effect");
    mustOk(await editor.activityEvents.get("activity-action-root"), "root activity side effect");

    const failures = {
      stale: !stale.ok ? stale.error.code : "",
      validation: !invalid.ok ? invalid.error.code : "",
      policy: !denied.ok ? denied.error.code : "",
      policyReason: failureReasonCode(denied),
    };
    const sideEffects = {
      assignedTo: changedTask.assigneeId,
      finalStatus: changedTask.status,
      createdTaskId: createdByAction.taskId,
      createdCommentId: createdByAction.commentId,
      projectActivityCount: projectActivity.activityCount,
      workspaceTasks: workspace.tasks,
      backlogCount: backlog.count,
    };
    const finalChecksum = checksum([
      firstMember.email,
      firstProject.key,
      indexedTaskIds.join(","),
      assigneeTaskIds.join(","),
      batchTaskIds.join(","),
      Object.values(finalCounts).join(","),
      Object.values(sideEffects).join(","),
      Object.values(failures).join(","),
      String(reopened.rev),
    ]);
    assert.equal(finalChecksum, FULL_PATH_EXPECTED_CHECKSUM);
    fullPathBenchmarkSink = finalChecksum;

    return {
      fixture: FULL_PATH_FIXTURE,
      operations: FULL_PATH_OPERATIONS,
      finalCounts,
      indexedTaskIds,
      assigneeTaskIds,
      listAllPages,
      batchTaskIds,
      sideEffects,
      failures,
      checksum: finalChecksum,
    };
  } finally {
    handler[Symbol.dispose]();
  }
}
