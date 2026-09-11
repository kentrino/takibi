import { DurableObject } from "cloudflare:workers";

export class StorageTestObject extends DurableObject<Cloudflare.Env> {
  ping(): string {
    return "ok";
  }
}

declare global {
  namespace Cloudflare {
    interface Env {
      TAKIBI_STORAGE_TEST: DurableObjectNamespace<StorageTestObject>;
    }
  }
}

export default {
  fetch(): Response {
    return new Response("Takibi worker-runtime test worker");
  },
};
