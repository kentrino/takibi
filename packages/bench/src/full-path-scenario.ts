import { Hono } from "hono";
import { takibiServer } from "@takibi/hono-adapter";
import {
  and,
  createTakibi,
  fullAccess,
  grant,
  none,
  queryImpliesEquality,
  type TakibiResult,
} from "takibi";
import { createClient } from "takibi/client";
import { withSqliteTestBackend } from "takibi/testing";
import {
  encodeWireRequest,
  isBatchWireResponse,
  isWireResponse,
  parseWireRequest,
  type WireRequest,
} from "@takibi/protocol";
import { z } from "zod";

const TENANT_ID = "tenant-a";
const EDITOR_ID = "member-01";
const BATCH_READ_COUNT = 12;
const LIST_ALL_PAGE_SIZE = 17;

type Role = "owner" | "editor" | "viewer";
type BenchmarkContext = {
  tenantId: string;
  actorId: string;
  role: Role;
};

type MemberInput = {
  tenantId: string;
  email: string;
  displayName: string;
  role: Role;
  preferences: {
    notifications: { email: boolean; digest: "daily" | "weekly" };
    display: { theme: "light" | "dark"; density: "comfortable" | "compact" };
  };
  createdBy: string;
};

type ProjectInput = {
  tenantId: string;
  key: string;
  name: string;
  description: string;
  status: "ACTIVE" | "ARCHIVED";
  ownerId: string;
  tags: string[];
  settings: {
    workflow: { requireEstimate: boolean; doneStatuses: string[] };
    notifications: { channel: string; enabled: boolean };
  };
  summary: { taskCount: number; completedTaskCount: number; activityCount: number };
};

type TaskInput = {
  tenantId: string;
  projectId: string;
  key: string;
  title: string;
  description: string;
  status: "TODO" | "IN_PROGRESS" | "DONE";
  priority: "LOW" | "MEDIUM" | "HIGH" | "URGENT";
  assigneeId: string;
  reporterId: string;
  watcherIds: string[];
  labels: string[];
  dueDate: string;
  estimateMinutes: number;
  rank: number;
  checklist: Array<{ id: string; text: string; done: boolean }>;
  customFields: {
    customer: string;
    impact: { score: number; areas: string[] };
    release: { train: string; blocked: boolean };
  };
  commentCount: number;
  audit: { source: string; importedBy: string; checksumHint: string };
};

type CommentInput = {
  tenantId: string;
  projectId: string;
  taskId: string;
  authorId: string;
  body: string;
  mentions: string[];
  reactions: Array<{ emoji: string; memberIds: string[] }>;
  sequence: number;
  metadata: { source: string; format: string; edited: boolean };
};

type ActivityInput = {
  tenantId: string;
  projectId: string;
  taskId: string;
  actorId: string;
  kind: "CREATED" | "ASSIGNED" | "PRIORITIZED" | "COMPLETED" | "REOPENED" | "COMMENTED";
  sequence: number;
  payload: {
    summary: string;
    changes: Array<{ field: string; before: string; after: string }>;
    source: { channel: string; requestId: string };
  };
};

function fixedText(label: string, length: number): string {
  const sentence = `${label} exercises deterministic nested storage, policy, query, and transport behavior. `;
  return sentence.repeat(Math.ceil(length / sentence.length)).slice(0, length);
}

function id(prefix: string, index: number): string {
  return `${prefix}-${String(index + 1).padStart(2, "0")}`;
}

function createFixture() {
  const members: Record<string, MemberInput> = {};
  for (let index = 0; index < 12; index += 1) {
    const memberId = id("member", index);
    members[memberId] = {
      tenantId: TENANT_ID,
      email: `member${String(index + 1).padStart(2, "0")}@example.test`,
      displayName: `Member ${String(index + 1).padStart(2, "0")}`,
      role: index === 0 ? "owner" : index < 8 ? "editor" : "viewer",
      preferences: {
        notifications: { email: index % 2 === 0, digest: index % 3 === 0 ? "weekly" : "daily" },
        display: {
          theme: index % 2 === 0 ? "light" : "dark",
          density: index % 3 === 0 ? "compact" : "comfortable",
        },
      },
      createdBy: EDITOR_ID,
    };
  }

  const projects: Record<string, ProjectInput> = {};
  for (let index = 0; index < 4; index += 1) {
    const projectId = id("project", index);
    projects[projectId] = {
      tenantId: TENANT_ID,
      key: `PRJ${index + 1}`,
      name: `Benchmark Project ${index + 1}`,
      description: fixedText(`Project ${index + 1}`, 520),
      status: "ACTIVE",
      ownerId: id("member", index),
      tags: ["benchmark", `stream-${index + 1}`, index % 2 === 0 ? "platform" : "product"],
      settings: {
        workflow: { requireEstimate: true, doneStatuses: ["DONE"] },
        notifications: { channel: `project-${index + 1}`, enabled: index % 2 === 0 },
      },
      summary: { taskCount: 15, completedTaskCount: 5, activityCount: 10 },
    };
  }

  const statuses = ["TODO", "IN_PROGRESS", "DONE"] as const;
  const priorities = ["URGENT", "HIGH", "MEDIUM", "LOW"] as const;
  const tasks: Record<string, TaskInput> = {};
  for (let index = 0; index < 60; index += 1) {
    const taskId = id("task", index);
    const projectId = id("project", index % 4);
    tasks[taskId] = {
      tenantId: TENANT_ID,
      projectId,
      key: `TASK-${String(index + 1).padStart(3, "0")}`,
      title: `Task ${String(index + 1).padStart(3, "0")} deterministic lifecycle`,
      description: fixedText(`Task ${index + 1} paragraph`, 1_420),
      status: statuses[index % statuses.length]!,
      priority: priorities[index % priorities.length]!,
      assigneeId: id("member", index % 12),
      reporterId: id("member", (index + 3) % 12),
      watcherIds: [id("member", (index + 1) % 12), id("member", (index + 2) % 12)],
      labels: ["benchmark", `team-${(index % 5) + 1}`, `area-${(index % 7) + 1}`],
      dueDate: `2026-${String((index % 9) + 1).padStart(2, "0")}-${String((index % 27) + 1).padStart(2, "0")}`,
      estimateMinutes: 30 + (index % 8) * 30,
      rank: index + 1,
      checklist: Array.from({ length: 6 }, (_, checklistIndex) => ({
        id: `check-${index + 1}-${checklistIndex + 1}`,
        text: `Verify deterministic step ${checklistIndex + 1} for task ${index + 1}`,
        done: checklistIndex < index % 4,
      })),
      customFields: {
        customer: `customer-${(index % 9) + 1}`,
        impact: { score: (index % 5) + 1, areas: [`surface-${index % 4}`, "runtime"] },
        release: { train: `2026.${(index % 6) + 1}`, blocked: index % 11 === 0 },
      },
      commentCount: index < 40 ? 2 : 1,
      audit: {
        source: "full-path-benchmark",
        importedBy: EDITOR_ID,
        checksumHint: `task-hint-${String(index + 1).padStart(3, "0")}`,
      },
    };
  }

  const comments: Record<string, CommentInput> = {};
  for (let index = 0; index < 100; index += 1) {
    const taskIndex = index % 60;
    comments[id("comment", index)] = {
      tenantId: TENANT_ID,
      projectId: id("project", taskIndex % 4),
      taskId: id("task", taskIndex),
      authorId: id("member", (index + 5) % 12),
      body: fixedText(`Comment ${index + 1} body`, 760),
      mentions: [id("member", (index + 1) % 12), id("member", (index + 7) % 12)],
      reactions: [
        { emoji: "thumbs-up", memberIds: [id("member", index % 12)] },
        { emoji: "eyes", memberIds: [id("member", (index + 2) % 12)] },
      ],
      sequence: index + 1,
      metadata: { source: "fixture", format: "plain-text", edited: index % 10 === 0 },
    };
  }

  const activityEvents: Record<string, ActivityInput> = {};
  for (let index = 0; index < 40; index += 1) {
    const taskIndex = index % 60;
    activityEvents[id("activity", index)] = {
      tenantId: TENANT_ID,
      projectId: id("project", taskIndex % 4),
      taskId: id("task", taskIndex),
      actorId: id("member", index % 12),
      kind: index % 2 === 0 ? "CREATED" : "COMMENTED",
      sequence: index + 1,
      payload: {
        summary: `Fixture activity ${index + 1}`,
        changes: [{ field: "status", before: "PLANNED", after: statuses[index % 3]! }],
        source: { channel: "fixture", requestId: `request-${String(index + 1).padStart(3, "0")}` },
      },
    };
  }

  return { members, projects, tasks, comments, activityEvents };
}

const FIXTURE = createFixture();

export const FULL_PATH_FIXTURE = {
  counts: {
    members: 12,
    projects: 4,
    tasks: 60,
    comments: 100,
    activityEvents: 40,
    total: 216,
  },
  serializedBytes: new TextEncoder().encode(JSON.stringify(FIXTURE)).byteLength,
} as const;

export const FULL_PATH_OPERATIONS = {
  directGets: 2,
  indexedLists: 2,
  listAllExpectedPages: 4,
  actionInvocations: 8,
  batchedReads: BATCH_READ_COUNT,
  invalidRequests: 1,
  deniedRequests: 1,
  protocolRequests: 3,
  responseEnvelopes: 2,
} as const;

export const FULL_PATH_EXPECTED_CHECKSUM = 1_054_551_378;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Full-path invariant failed: ${message}`);
}

function mustOk<T>(result: TakibiResult<T>, label: string): T {
  if (!result.ok) {
    throw new Error(`${label} failed with ${result.error.code}: ${result.error.message}`);
  }
  return result.data;
}

function mustFail<T>(result: TakibiResult<T>, code: string, label: string): void {
  if (result.ok) throw new Error(`${label} unexpectedly succeeded`);
  assert(result.error.code === code, `${label} returned ${result.error.code}, expected ${code}`);
}

function failureReasonCode<T>(result: TakibiResult<T>): string {
  if (result.ok || result.error.kind !== "operation" || !("reason" in result.error)) return "";
  const reason = result.error.reason as { code?: unknown } | undefined;
  return typeof reason?.code === "string" ? reason.code : "";
}

function sameValues(actual: readonly string[], expected: readonly string[], label: string): void {
  assert(
    actual.length === expected.length && actual.every((value, index) => value === expected[index]),
    `${label} order mismatch: ${actual.join(",")}`,
  );
}

function checksum(parts: readonly string[]): number {
  let value = 2_166_136_261;
  for (const byte of new TextEncoder().encode(parts.join("|"))) {
    value ^= byte;
    value = Math.imul(value, 16_777_619);
  }
  return value >>> 0;
}

function createSchemas() {
  const TenantId = z.string().min(1);
  const Member = z.object({
    tenantId: TenantId,
    email: z.string().email(),
    displayName: z.string().min(1),
    role: z.enum(["owner", "editor", "viewer"]),
    preferences: z.object({
      notifications: z.object({ email: z.boolean(), digest: z.enum(["daily", "weekly"]) }),
      display: z.object({
        theme: z.enum(["light", "dark"]),
        density: z.enum(["comfortable", "compact"]),
      }),
    }),
    createdBy: z.string().min(1),
  });
  const Project = z.object({
    tenantId: TenantId,
    key: z.string().min(2),
    name: z.string().min(1),
    description: z.string().min(100),
    status: z.enum(["ACTIVE", "ARCHIVED"]),
    ownerId: z.string().min(1),
    tags: z.array(z.string()).min(1),
    settings: z.object({
      workflow: z.object({ requireEstimate: z.boolean(), doneStatuses: z.array(z.string()) }),
      notifications: z.object({ channel: z.string(), enabled: z.boolean() }),
    }),
    summary: z.object({
      taskCount: z.number().int().nonnegative(),
      completedTaskCount: z.number().int().nonnegative(),
      activityCount: z.number().int().nonnegative(),
    }),
  });
  const Task = z.object({
    tenantId: TenantId,
    projectId: z.string().min(1),
    key: z.string().min(1),
    title: z.string().min(3),
    description: z.string().min(500),
    status: z.enum(["TODO", "IN_PROGRESS", "DONE"]),
    priority: z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]),
    assigneeId: z.string().min(1),
    reporterId: z.string().min(1),
    watcherIds: z.array(z.string()),
    labels: z.array(z.string()),
    dueDate: z.string().min(10),
    estimateMinutes: z.number().int().positive(),
    rank: z.number().int().nonnegative(),
    checklist: z
      .array(z.object({ id: z.string(), text: z.string().min(1), done: z.boolean() }))
      .min(1),
    customFields: z.object({
      customer: z.string(),
      impact: z.object({ score: z.number().int(), areas: z.array(z.string()) }),
      release: z.object({ train: z.string(), blocked: z.boolean() }),
    }),
    commentCount: z.number().int().nonnegative(),
    audit: z.object({ source: z.string(), importedBy: z.string(), checksumHint: z.string() }),
  });
  const Comment = z.object({
    tenantId: TenantId,
    projectId: z.string(),
    taskId: z.string(),
    authorId: z.string(),
    body: z.string().min(500),
    mentions: z.array(z.string()),
    reactions: z.array(z.object({ emoji: z.string(), memberIds: z.array(z.string()) })),
    sequence: z.number().int().positive(),
    metadata: z.object({ source: z.string(), format: z.string(), edited: z.boolean() }),
  });
  const ActivityEvent = z.object({
    tenantId: TenantId,
    projectId: z.string(),
    taskId: z.string(),
    actorId: z.string(),
    kind: z.enum(["CREATED", "ASSIGNED", "PRIORITIZED", "COMPLETED", "REOPENED", "COMMENTED"]),
    sequence: z.number().int().positive(),
    payload: z.object({
      summary: z.string(),
      changes: z.array(z.object({ field: z.string(), before: z.string(), after: z.string() })),
      source: z.object({ channel: z.string(), requestId: z.string() }),
    }),
  });
  return { Member, Project, Task, Comment, ActivityEvent };
}

function headers(context: BenchmarkContext): Record<string, string> {
  return {
    "x-benchmark-tenant": context.tenantId,
    "x-benchmark-actor": context.actorId,
    "x-benchmark-role": context.role,
  };
}

function actionEvent(input: {
  eventId: string;
  projectId: string;
  taskId: string;
  actorId: string;
  kind: ActivityInput["kind"];
  sequence: number;
  field: string;
  before: string;
  after: string;
}): ActivityInput {
  return {
    tenantId: TENANT_ID,
    projectId: input.projectId,
    taskId: input.taskId,
    actorId: input.actorId,
    kind: input.kind,
    sequence: input.sequence,
    payload: {
      summary: `${input.kind} ${input.taskId}`,
      changes: [{ field: input.field, before: input.before, after: input.after }],
      source: { channel: "benchmark-action", requestId: input.eventId },
    },
  };
}

function buildProductionHandler() {
  const schemas = createSchemas();
  const context = createTakibi()({
    resolve: ({ request }): BenchmarkContext => ({
      tenantId: request.headers.get("x-benchmark-tenant") ?? "",
      actorId: request.headers.get("x-benchmark-actor") ?? "",
      role: (request.headers.get("x-benchmark-role") ?? "viewer") as Role,
    }),
  });

  const authenticated = context.policy(
    { reason: { code: "BENCHMARK_ACTOR_REQUIRED" } },
    ({ actorId }) => (actorId === "" ? none : fullAccess),
  );
  const editor = context.policy(
    {
      reason: {
        code: "EDITOR_REQUIRED",
        description: "The benchmark write path requires an editor.",
      },
    },
    ({ role }) => (role === "owner" || role === "editor" ? fullAccess : none),
  );
  const memberAccess = context.policy(
    { schema: schemas.Member, reason: { code: "MEMBER_TENANT_REQUIRED" } },
    ({ tenantId, role, operation, where, doc, nextDoc }) => {
      if (operation === "list") {
        return queryImpliesEquality(where, "tenantId", tenantId) ? grant("list") : none;
      }
      const targetTenant = nextDoc?.tenantId ?? doc?.tenantId;
      if (targetTenant !== tenantId) return none;
      return role === "owner" || role === "editor" ? fullAccess : grant("get");
    },
  );
  const projectAccess = context.policy(
    { schema: schemas.Project, reason: { code: "PROJECT_TENANT_REQUIRED" } },
    ({ tenantId, role, operation, where, doc, nextDoc }) => {
      if (operation === "list") {
        return queryImpliesEquality(where, "tenantId", tenantId) ? grant("list") : none;
      }
      const targetTenant = nextDoc?.tenantId ?? doc?.tenantId;
      if (targetTenant !== tenantId) return none;
      return role === "owner" || role === "editor" ? fullAccess : grant("get");
    },
  );
  const taskAccess = context.policy(
    { schema: schemas.Task, reason: { code: "TASK_TENANT_REQUIRED" } },
    ({ tenantId, role, operation, where, doc, nextDoc }) => {
      if (operation === "list") {
        return queryImpliesEquality(where, "tenantId", tenantId) ? grant("list") : none;
      }
      if (operation === "invoke" && doc === undefined) {
        return role === "owner" || role === "editor" ? grant("list", "invoke") : none;
      }
      const targetTenant = nextDoc?.tenantId ?? doc?.tenantId;
      if (targetTenant !== tenantId) return none;
      return role === "owner" || role === "editor" ? fullAccess : grant("get");
    },
  );
  const commentAccess = context.policy(
    { schema: schemas.Comment, reason: { code: "COMMENT_TENANT_REQUIRED" } },
    ({ tenantId, role, operation, where, doc, nextDoc }) => {
      if (operation === "list") {
        return queryImpliesEquality(where, "tenantId", tenantId) ? grant("list") : none;
      }
      if ((nextDoc?.tenantId ?? doc?.tenantId) !== tenantId) return none;
      return role === "owner" || role === "editor" ? fullAccess : grant("get");
    },
  );
  const activityAccess = context.policy(
    { schema: schemas.ActivityEvent, reason: { code: "ACTIVITY_TENANT_REQUIRED" } },
    ({ tenantId, role, operation, where, doc, nextDoc }) => {
      if (operation === "list") {
        return queryImpliesEquality(where, "tenantId", tenantId) ? grant("list") : none;
      }
      if ((nextDoc?.tenantId ?? doc?.tenantId) !== tenantId) return none;
      return role === "owner" || role === "editor" ? fullAccess : grant("get");
    },
  );

  const collections = context.defineCollections({
    members: {
      schema: schemas.Member,
      accessPolicy: and(authenticated, memberAccess),
      unique: { byTenantEmail: ["tenantId", "email"] },
      indexes: { byTenantRole: ["tenantId", "role", "displayName"] },
      seed: () => FIXTURE.members,
    },
    projects: {
      schema: schemas.Project,
      accessPolicy: and(authenticated, projectAccess),
      unique: { byTenantKey: ["tenantId", "key"] },
      indexes: { byTenantStatus: ["tenantId", "status", "key"] },
      seed: () => FIXTURE.projects,
    },
    tasks: {
      schema: schemas.Task,
      accessPolicy: and(authenticated, taskAccess),
      unique: { byTenantKey: ["tenantId", "key"] },
      indexes: {
        byProjectStatusPriority: ["tenantId", "projectId", "status", "priority", "rank"],
        byAssigneeOrder: ["tenantId", "assigneeId", "rank"],
      },
      seed: () => FIXTURE.tasks,
    },
    comments: {
      schema: schemas.Comment,
      accessPolicy: and(authenticated, commentAccess),
      indexes: { byTaskOrder: ["tenantId", "taskId", "sequence"] },
      seed: () => FIXTURE.comments,
    },
    activityEvents: {
      schema: schemas.ActivityEvent,
      accessPolicy: and(authenticated, activityAccess),
      indexes: { byProjectOrder: ["tenantId", "projectId", "sequence"] },
      seed: () => FIXTURE.activityEvents,
    },
  });

  const taskActions = collections.tasks.actions((defineAction) => ({
    assign: defineAction()
      .input(
        z.object({
          assignment: z.object({ assigneeId: z.string(), changedBy: z.string() }),
          eventId: z.string(),
          sequence: z.number().int(),
        }),
      )
      .atomic()
      .policy(and(editor, taskAccess))
      .handler(async ({ input, doc, id: taskId, $collection, $collections }) => {
        const updated = await $collection.update(taskId, {
          assigneeId: input.assignment.assigneeId,
          watcherIds: [...new Set([...doc.watcherIds, input.assignment.assigneeId])],
          rev: doc.rev,
        });
        await $collections.activityEvents.add(
          actionEvent({
            eventId: input.eventId,
            projectId: doc.projectId,
            taskId,
            actorId: input.assignment.changedBy,
            kind: "ASSIGNED",
            sequence: input.sequence,
            field: "assigneeId",
            before: doc.assigneeId,
            after: input.assignment.assigneeId,
          }),
          { id: input.eventId },
        );
        return { taskId, assigneeId: updated.assigneeId, rev: updated.rev };
      }),
    reprioritize: defineAction()
      .input(
        z.object({
          priority: z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]),
          expectedRevision: z.number().int(),
          eventId: z.string(),
          sequence: z.number().int(),
        }),
      )
      .atomic()
      .policy(and(editor, taskAccess))
      .handler(async ({ input, doc, id: taskId, $collection, $collections, ctx }) => {
        assert(doc.rev === input.expectedRevision, "reprioritize action revision drift");
        const updated = await $collection.update(taskId, {
          priority: input.priority,
          rev: input.expectedRevision,
        });
        await $collections.activityEvents.add(
          actionEvent({
            eventId: input.eventId,
            projectId: doc.projectId,
            taskId,
            actorId: ctx.actorId,
            kind: "PRIORITIZED",
            sequence: input.sequence,
            field: "priority",
            before: doc.priority,
            after: input.priority,
          }),
          { id: input.eventId },
        );
        return { taskId, priority: updated.priority, rev: updated.rev };
      }),
    complete: defineAction()
      .input(z.object({ eventId: z.string(), sequence: z.number().int() }))
      .atomic()
      .policy(and(editor, taskAccess))
      .handler(async ({ input, doc, id: taskId, $collection, $collections, ctx }) => {
        const project = await $collections.projects.get(doc.projectId);
        const updated = await $collection.update(taskId, { status: "DONE", rev: doc.rev });
        await $collections.projects.update(project.id, {
          summary: {
            ...project.summary,
            completedTaskCount: project.summary.completedTaskCount + 1,
          },
          rev: project.rev,
        });
        await $collections.activityEvents.add(
          actionEvent({
            eventId: input.eventId,
            projectId: doc.projectId,
            taskId,
            actorId: ctx.actorId,
            kind: "COMPLETED",
            sequence: input.sequence,
            field: "status",
            before: doc.status,
            after: "DONE",
          }),
          { id: input.eventId },
        );
        return { taskId, status: updated.status, rev: updated.rev };
      }),
    reopen: defineAction()
      .input(z.object({ eventId: z.string(), sequence: z.number().int() }))
      .policy(and(editor, taskAccess))
      .handler(async ({ input, doc, id: taskId, $collection, $collections, ctx }) => {
        const updated = await $collection.update(taskId, { status: "TODO", rev: doc.rev });
        await $collections.activityEvents.add(
          actionEvent({
            eventId: input.eventId,
            projectId: doc.projectId,
            taskId,
            actorId: ctx.actorId,
            kind: "REOPENED",
            sequence: input.sequence,
            field: "status",
            before: doc.status,
            after: "TODO",
          }),
          { id: input.eventId },
        );
        return { taskId, status: updated.status, rev: updated.rev };
      }),
    createWithInitialComment: defineAction()
      .detached()
      .input(
        z.object({
          task: schemas.Task,
          taskId: z.string(),
          comment: schemas.Comment,
          commentId: z.string(),
          eventId: z.string(),
          sequence: z.number().int(),
        }),
      )
      .atomic()
      .policy(editor)
      .handler(async ({ input, $collections, ctx }) => {
        const project = await $collections.projects.get(input.task.projectId);
        const task = await $collections.tasks.add(input.task, { id: input.taskId });
        const comment = await $collections.comments.add(input.comment, { id: input.commentId });
        await $collections.activityEvents.add(
          actionEvent({
            eventId: input.eventId,
            projectId: input.task.projectId,
            taskId: input.taskId,
            actorId: ctx.actorId,
            kind: "CREATED",
            sequence: input.sequence,
            field: "task",
            before: "missing",
            after: input.task.key,
          }),
          { id: input.eventId },
        );
        await $collections.projects.update(project.id, {
          summary: { ...project.summary, taskCount: project.summary.taskCount + 1 },
          rev: project.rev,
        });
        return { taskId: task.id, commentId: comment.id };
      }),
    backlogSummary: defineAction()
      .detached()
      .input(z.object({ projectId: z.string().optional() }).optional())
      .requires("list")
      .policy(grant("list"))
      .handler(async ({ input, $collection }) => {
        const tasks = await $collection.listAll({
          pageSize: 19,
          where: (query) =>
            input?.projectId
              ? query.and(
                  query.tenantId.eq(TENANT_ID),
                  query.projectId.eq(input.projectId),
                  query.status.in(["TODO", "IN_PROGRESS"]),
                )
              : query.and(query.tenantId.eq(TENANT_ID), query.status.in(["TODO", "IN_PROGRESS"])),
        });
        return {
          count: tasks.length,
          estimateMinutes: tasks.reduce((total, task) => total + task.estimateMinutes, 0),
        };
      }),
  }));

  const recordProjectActivity = collections
    .defineAction()
    .input(
      z.object({
        projectId: z.string(),
        taskId: z.string(),
        eventId: z.string(),
        sequence: z.number().int(),
        details: z.object({ channel: z.string(), note: z.string() }),
      }),
    )
    .atomic()
    .policy(editor)
    .handler(async ({ input, $collections, ctx }) => {
      const project = await $collections.projects.get(input.projectId);
      await $collections.activityEvents.add(
        {
          tenantId: TENANT_ID,
          projectId: input.projectId,
          taskId: input.taskId,
          actorId: ctx.actorId,
          kind: "COMMENTED",
          sequence: input.sequence,
          payload: {
            summary: input.details.note,
            changes: [{ field: "channel", before: "none", after: input.details.channel }],
            source: { channel: input.details.channel, requestId: input.eventId },
          },
        },
        { id: input.eventId },
      );
      const updated = await $collections.projects.update(project.id, {
        summary: { ...project.summary, activityCount: project.summary.activityCount + 1 },
        rev: project.rev,
      });
      return { projectId: updated.id, activityCount: updated.summary.activityCount };
    });

  const workspaceSummary = collections
    .defineAction()
    .input(z.object({ includeArchived: z.boolean() }).optional())
    .policy(grant("invoke"))
    .handler(async ({ input, $collections }) => {
      const projects = await $collections.projects.listAll({
        where: (query) =>
          input?.includeArchived
            ? query.tenantId.eq(TENANT_ID)
            : query.and(query.tenantId.eq(TENANT_ID), query.status.eq("ACTIVE")),
      });
      const tasks = await $collections.tasks.listAll({
        where: (query) => query.tenantId.eq(TENANT_ID),
      });
      return {
        projects: projects.length,
        tasks: tasks.length,
        completed: tasks.filter((task) => task.status === "DONE").length,
      };
    });

  return collections.actions({
    tasks: taskActions,
    $: { recordProjectActivity, workspaceSummary },
  });
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
  protocol: { requestCount: number; encodedBytes: number; responsesValidated: number };
  checksum: number;
};

export let fullPathBenchmarkSink = 0;

export async function runFullPathScenario(): Promise<FullPathScenarioReport> {
  const production = buildProductionHandler();
  const handler = withSqliteTestBackend(production);
  const app = new Hono().use("*", takibiServer({ handler, createContext: () => ({}) }));
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
    assert(firstMember.email === "member01@example.test", "seeded member changed");
    assert(firstProject.key === "PRJ1", "seeded project changed");

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
    sameValues(
      indexedTaskIds,
      ["task-01", "task-13", "task-25", "task-37", "task-49"],
      "project indexed list",
    );
    assert(indexed.nextCursor === undefined, "unexpected indexed list cursor");

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
    sameValues(
      assigneeTaskIds,
      ["task-49", "task-37", "task-25", "task-13", "task-01"],
      "assignee indexed list",
    );

    const listRequestsBefore = requestCounts.list;
    const allTasks = mustOk(
      await editor.tasks.listAll({
        pageSize: LIST_ALL_PAGE_SIZE,
        where: (query) => query.tenantId.eq(TENANT_ID),
      }),
      "task listAll",
    );
    const listAllPages = requestCounts.list - listRequestsBefore;
    assert(allTasks.length === 60, `listAll returned ${allTasks.length} tasks`);
    assert(listAllPages === 4, `listAll used ${listAllPages} pages`);

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
    assert(updatedTemporary.rev === temporary.rev + 1, "revision did not advance");
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
    assert(completed.rev === reprioritized.rev + 1, "complete revision mismatch");
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
    assert(requestCounts.batch === 1, `batch route called ${requestCounts.batch} times`);
    const batchTaskIds = batchResults.map(
      (result, index) => mustOk(result, `batch item ${index}`).id,
    );
    sameValues(
      batchTaskIds,
      Array.from({ length: BATCH_READ_COUNT }, (_, index) => id("task", index)),
      "batch item mapping",
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
    assert(failureReasonCode(denied) === "EDITOR_REQUIRED", "viewer denial reason changed");

    mustOk(await editor.tasks.delete("task-benchmark-temp"), "temporary task delete");
    const deleted = await editor.tasks.get("task-benchmark-temp");
    mustFail(deleted, "NOT_FOUND", "deleted task get");

    const wireRequests: WireRequest[] = [
      {
        kind: "collection",
        collection: "tasks",
        operation: "get",
        id: "task-01",
        context: editorContext,
      },
      {
        kind: "action",
        scope: "$",
        name: "workspaceSummary",
        context: editorContext,
      },
      {
        kind: "batch",
        items: [
          { kind: "collection", collection: "tasks", operation: "get", id: "task-01" },
          {
            kind: "collection",
            collection: "tasks",
            operation: "list",
            list: { limit: 2, where: { field: "tenantId", op: "eq", value: TENANT_ID } },
          },
        ],
        context: editorContext,
      },
    ];
    let encodedBytes = 0;
    for (const request of wireRequests) {
      const encoded = encodeWireRequest(request);
      encodedBytes += new TextEncoder().encode(encoded).byteLength;
      assert(
        JSON.stringify(parseWireRequest(encoded)) === JSON.stringify(request),
        "protocol request round-trip changed",
      );
    }
    const successEnvelope = JSON.parse(
      JSON.stringify({ ok: true, data: { id: "task-01", status: "TODO" } }),
    ) as unknown;
    const batchEnvelope = JSON.parse(
      JSON.stringify({
        ok: true,
        data: [
          { ok: true, data: { id: "task-01" } },
          {
            ok: false,
            error: {
              kind: "operation",
              code: "NOT_FOUND",
              message: "Document not found",
              status: 404,
            },
          },
        ],
      }),
    ) as unknown;
    assert(isWireResponse(successEnvelope), "single response validation failed");
    assert(isBatchWireResponse(batchEnvelope, 2), "batch response validation failed");

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
    assert(
      JSON.stringify(finalCounts) ===
        JSON.stringify({ members: 12, projects: 4, tasks: 61, comments: 101, activityEvents: 46 }),
      `final counts changed: ${JSON.stringify(finalCounts)}`,
    );
    const changedTask = mustOk(await editor.tasks.get("task-02"), "changed task");
    assert(changedTask.assigneeId === "member-03", "assignment side effect missing");
    assert(changedTask.status === "TODO", "reopen side effect missing");
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
      String(encodedBytes),
      String(reopened.rev),
    ]);
    assert(
      finalChecksum === FULL_PATH_EXPECTED_CHECKSUM,
      `checksum ${finalChecksum} !== ${FULL_PATH_EXPECTED_CHECKSUM}`,
    );
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
      protocol: {
        requestCount: wireRequests.length,
        encodedBytes,
        responsesValidated: 2,
      },
      checksum: finalChecksum,
    };
  } finally {
    handler[Symbol.dispose]();
  }
}
