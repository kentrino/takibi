import { matchesPublicPrefix, decodePublicHttp, type PublicRequest } from "../http";
import type { HandleOptions, HandleResult } from "./types";

export type ServeCall<TInitial = unknown> = (
  request: Request,
  initial: TInitial,
  decode: () => Promise<PublicRequest>,
) => Promise<Response>;

/** Framework-independent HTTP entry with caller-supplied context. */
export type HttpHandler<TInitial> = {
  handle(request: Request, options: HandleOptions<TInitial>): Promise<HandleResult>;
};

/** This entry always receives the initial value from its caller. */
export function createHttpHandler<TInitial>(serve: ServeCall<TInitial>): HttpHandler<TInitial> {
  return {
    async handle(request, options) {
      if (!matchesPublicPrefix(new URL(request.url).pathname, options.prefix)) {
        return { matched: false };
      }
      const response = await serve(request, options.context, () =>
        decodePublicHttp(request, options.prefix),
      );
      return { matched: true, response };
    },
  };
}
