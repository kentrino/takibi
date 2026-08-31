import { DurableObject } from "cloudflare:workers";

export class AdapterTestObject extends DurableObject<Cloudflare.Env> {
  ping(): string {
    return "ok";
  }
}

declare global {
  namespace Cloudflare {
    interface Env {
      TAKIBI_ADAPTER_TEST: DurableObjectNamespace<AdapterTestObject>;
    }
  }
}

export default {
  fetch(): Response {
    return new Response("Takibi Better Auth adapter test worker");
  },
};
