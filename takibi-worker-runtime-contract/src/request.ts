import type { RunCall } from "./type";

export class TakibiContractStateError extends Error {
  /**
   * Creates an internal error that distinguishes invalid invocation state
   * transitions from business failures.
   */
  constructor(message: string) {
    super(message);
    this.name = "TakibiContractStateError";
  }
}

export class TakibiContractConfigurationError extends Error {
  /**
   * Creates an internal error that distinguishes invocation adapter wiring
   * defects and invalid effect transitions from business failures.
   */
  constructor(message: string) {
    super(message);
    this.name = "TakibiContractConfigurationError";
  }
}

/**
 * Decodes, resolves context, and dispatches one request in strict linear order.
 * Failures are intentionally not converted into call state; the caller owns error mapping.
 */
export const runCall: RunCall = async function <TRequestLike, TDecoded, TContext, TResponseObject>(
  request: TRequestLike,
  adapters: {
    decode: (request: TRequestLike) => TDecoded | Promise<TDecoded>;
    resolveContext: (input: {
      request: TRequestLike;
      decoded: TDecoded;
    }) => TContext | Promise<TContext>;
    dispatch: (input: {
      request: TRequestLike;
      decoded: TDecoded;
      context: TContext;
    }) => TResponseObject | Promise<TResponseObject>;
  },
): Promise<TResponseObject> {
  const decoded = await adapters.decode(request);
  const context = await adapters.resolveContext({ request, decoded });
  return adapters.dispatch({ request, decoded, context });
};
