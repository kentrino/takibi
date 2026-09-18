// Smoke test for the "app" image: exercise the *built* Takibi SDK on a clean
// Node runtime, with no node_modules. It creates a collection, writes a record
// and reads it back through the SQLite test backend (node:sqlite), which is why
// the runtime needs Node >= 22.18.0. A minimal Standard Schema is used inline so
// the image needs nothing beyond the built package.
import { createTakibi, fullAccess } from "./takibi/dist/index.mjs";
import { withSqliteTestBackend } from "./takibi/dist/testing.mjs";
import { createClient } from "./takibi/dist/client.mjs";

const noteSchema = {
  "~standard": {
    version: 1,
    vendor: "takibi-app-smoke",
    validate(value) {
      return typeof value === "object" && value && typeof value.title === "string"
        ? { value }
        : { issues: [{ message: "title must be a string" }] };
    },
  },
};

const context = createTakibi()({ resolve: () => ({ tenantId: "smoke" }) });
const app = context.defineCollections({
  notes: { schema: noteSchema, accessPolicy: fullAccess },
});
const production = app.actions({});
const handler = withSqliteTestBackend(production);
const client = createClient("http://takibi.smoke", {
  fetch: async (input, init) => {
    const result = await handler.handle(new Request(input, init), { context: {} });
    if (!result.matched) throw new Error("unmatched takibi request");
    return result.response;
  },
});

const added = await client.notes.add({ title: "hello from docker" }, { id: "note-1" });
if (!added.ok) throw new Error(`add failed: ${JSON.stringify(added.error)}`);

const got = await client.notes.get("note-1");
if (!got.ok || got.data.title !== "hello from docker") {
  throw new Error(`get mismatch: ${JSON.stringify(got)}`);
}

console.log(
  "takibi app smoke OK:",
  JSON.stringify({ node: process.version, id: got.data.id, title: got.data.title }),
);
handler[Symbol.dispose]();
