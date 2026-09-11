import { expect, test } from "vite-plus/test";
import { z } from "zod";
import { defineCollection, type CollectionDefinition } from "@takibi/api";
import { fullAccess, none, type AccessContext } from "@takibi/policy";
import type { WithMetadata } from "@takibi/shared-types";
import type { PolicySurface } from "@takibi/worker-runtime-contract";
import { PolicyEvaluator, tracePolicyEvaluator } from "../src/invocation-collaborators";

type Staff = { role: "staff" };
type Patient = { role: "patient" };
type Visit = WithMetadata<{ note: string }>;
type Invoice = WithMetadata<{ amount: number }>;

const visitSchema = z.object({ note: z.string() });
const invoiceSchema = z.object({ amount: z.number() });
const visits: CollectionDefinition<typeof visitSchema, Staff> = {
  schema: visitSchema,
  accessPolicy: (_ctx: AccessContext<Staff, Visit>) => fullAccess,
};
const invoices: CollectionDefinition<typeof invoiceSchema, Patient> = {
  schema: invoiceSchema,
  accessPolicy: (_ctx: AccessContext<Patient, Invoice>) => fullAccess,
};
const visitCtx: AccessContext<Staff, Visit> = {
  role: "staff",
  collection: "visits",
  operation: "get",
  permission: "get",
  doc: { id: "v1", note: "Follow up", createdAt: "now", updatedAt: "now" },
};
const invoiceCtx: AccessContext<Patient, Invoice> = {
  role: "patient",
  collection: "invoices",
  operation: "get",
  permission: "get",
  doc: { id: "i1", amount: 100, createdAt: "now", updatedAt: "now" },
};
const options = { conceal: false };

test("one evaluator accepts different typed collections and a contract override", async () => {
  const evaluator = new PolicyEvaluator();
  const override: PolicySurface = {
    evaluateCollection: (def, ctx, opts) => evaluator.evaluateCollection(def, ctx, opts),
    evaluateAction: (...args) => evaluator.evaluateAction(...args),
  };
  for (const policy of [evaluator, override, tracePolicyEvaluator(evaluator, undefined)]) {
    expect(await policy.evaluateCollection(visits, visitCtx, options)).toBe(fullAccess);
    expect(await policy.evaluateCollection(invoices, invoiceCtx, options)).toBe(fullAccess);
  }
});

// Compile-only calls: invalid inputs must fail both exported boundaries.
function rejectMismatches(evaluator: PolicyEvaluator, adapter: PolicySurface) {
  const wrongContext = { ...visitCtx, role: "patient" as const };
  const wrongDocument = { ...visitCtx, doc: invoiceCtx.doc };
  const wrongCandidate = { ...visitCtx, nextDoc: invoiceCtx.doc };
  // @ts-expect-error the visit policy requires a staff context
  void evaluator.evaluateCollection(visits, wrongContext, options);
  // @ts-expect-error the visit schema requires a note document
  void evaluator.evaluateCollection(visits, wrongDocument, options);
  // @ts-expect-error write candidates must also match the visit schema
  void evaluator.evaluateCollection(visits, wrongCandidate, options);
  // @ts-expect-error a second collection cannot reuse the first collection context
  void evaluator.evaluateCollection(invoices, visitCtx, options);
  // @ts-expect-error contract adapters must preserve the required context
  void adapter.evaluateCollection(visits, wrongContext, options);
  // @ts-expect-error contract adapters must preserve the schema document type
  void adapter.evaluateCollection(visits, wrongDocument, options);
  // @ts-expect-error contract adapters must preserve the write candidate type
  void adapter.evaluateCollection(visits, wrongCandidate, options);
  // @ts-expect-error a second collection cannot reuse the first collection context
  void adapter.evaluateCollection(invoices, visitCtx, options);
}
void rejectMismatches;

test("typed collection evaluation preserves denial and concealment", async () => {
  const denied = defineCollection({ schema: visits.schema, accessPolicy: none });
  const evaluator = tracePolicyEvaluator(new PolicyEvaluator(), undefined);
  await expect(evaluator.evaluateCollection(denied, visitCtx, options)).rejects.toMatchObject({
    code: "FORBIDDEN",
  });
  await expect(
    evaluator.evaluateCollection(denied, visitCtx, { conceal: true, id: "v1" }),
  ).rejects.toMatchObject({ code: "NOT_FOUND", message: "Document not found: v1" });
});
