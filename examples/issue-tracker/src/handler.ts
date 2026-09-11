import { and, createTakibi, fullAccess, grant, none, queryImpliesEquality } from "takibi";
import { z } from "zod";

export const TENANT_ID = "tenant-a";
export const EDITOR_ID = "member-01";
export const BATCH_READ_COUNT = 12;
export const LIST_ALL_PAGE_SIZE = 17;

export type Role = "owner" | "editor" | "viewer";
export type BenchmarkContext = {
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

export type TaskInput = {
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

export function fixedText(label: string, length: number): string {
  const sentence = `${label} exercises deterministic nested storage, policy, query, and transport behavior. `;
  return sentence.repeat(Math.ceil(length / sentence.length)).slice(0, length);
}

export function id(prefix: string, index: number): string {
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

export const FIXTURE = createFixture();

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

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Full-path invariant failed: ${message}`);
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

export function headers(context: BenchmarkContext): Record<string, string> {
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

export function createIssueTrackerHandler() {
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
