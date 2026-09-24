import { createIssueTrackerHandler } from "@takibi/issue-tracker";
import { createClient } from "takibi/client";

const handler = createIssueTrackerHandler();
export const client = createClient<typeof handler>("https://takibi.example");

export type MemberGet = Awaited<ReturnType<typeof client.members.get>>;
export type TaskList = Awaited<ReturnType<typeof client.tasks.list>>;
export type WorkspaceSummary = Awaited<ReturnType<typeof client.workspaceSummary>>;
