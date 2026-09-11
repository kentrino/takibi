import { createTakibi, fullAccess, grant, none } from "takibi";
import { createClient } from "takibi/client";
import { registerGlobalTracer } from "takibi/instrumentation";
import { takibiServer } from "@takibi/hono-adapter";

export const publicSurface = {
  createTakibi,
  fullAccess,
  grant,
  none,
  createClient,
  registerGlobalTracer,
  takibiServer,
};
