import { createTakibi, none, read, UnauthorizedError } from "takibi";
import { z } from "zod";

type Initial = {
  authenticate(request: Request): Promise<{ userId: string; tenantId: string } | null>;
  loadMembership(userId: string, tenantId: string): Promise<{ canRead: boolean }>;
  tenantStore(tenantId: string): { fetch(request: Request): Promise<Response> };
};

export function createPolicyExample() {
  const context = createTakibi<Initial>()({
    resolve: async ({ request, context }) => {
      const identity = await context.authenticate(request);
      if (!identity) throw new UnauthorizedError("Sign in required");
      const { userId, tenantId } = identity;
      const { canRead } = await context.loadMembership(userId, tenantId);
      return { userId, tenantId, canRead };
    },
    stub: ({ context, resolved }) => context.tenantStore(resolved.tenantId),
  });
  return context
    .defineCollections({
      posts: {
        schema: z.object({ title: z.string() }),
        accessPolicy: async ({ canRead }) => (canRead ? read : none),
      },
    })
    .actions({});
}
