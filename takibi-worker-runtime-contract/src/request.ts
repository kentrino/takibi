import type {
  CallAdapters,
  CallFailureInput,
  CallFailureStage,
  CallTerminalEvent,
  MaybePromise,
  RunCall,
} from "./type";

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

async function ignoreObserverFailure(work: () => MaybePromise<void>): Promise<void> {
  try {
    await work();
  } catch {
    // Observation must not replace the Call result or re-dispatch.
  }
}

/**
 * Envelope Call runner. Platform decode / resolve / dispatch / conversion
 * live on the injected adapters. `run` owns progression so `withTracing` can
 * wrap a method such as `resolveContext` without a second control-flow copy.
 */
export class Call<
  TRequestLike,
  TDecoded,
  TContext,
  TResponseObject,
  TDispatched = TResponseObject,
> {
  readonly #adapters: CallAdapters<TRequestLike, TDecoded, TContext, TResponseObject, TDispatched>;

  constructor(
    adapters: CallAdapters<TRequestLike, TDecoded, TContext, TResponseObject, TDispatched>,
  ) {
    this.#adapters = adapters;
  }

  async decode(request: TRequestLike): Promise<TDecoded> {
    return this.#adapters.decode(request);
  }

  async resolveContext(input: { request: TRequestLike; decoded: TDecoded }): Promise<TContext> {
    return this.#adapters.resolveContext(input);
  }

  async dispatch(input: {
    request: TRequestLike;
    decoded: TDecoded;
    context: TContext;
  }): Promise<TDispatched> {
    return this.#adapters.dispatch(input);
  }

  async toResponse(input: {
    request: TRequestLike;
    decoded: TDecoded;
    context: TContext;
    dispatched: TDispatched;
  }): Promise<TResponseObject> {
    return this.#adapters.toResponse
      ? this.#adapters.toResponse(input)
      : (input.dispatched as unknown as TResponseObject);
  }

  async toFailureResponse(
    failure: CallFailureInput<TRequestLike, TDecoded, TContext>,
  ): Promise<TResponseObject> {
    if (this.#adapters.toFailureResponse === undefined) {
      throw failure.error;
    }
    return this.#adapters.toFailureResponse(failure);
  }

  async onDecoded(input: { request: TRequestLike; decoded: TDecoded }): Promise<void> {
    await this.#adapters.onDecoded?.(input);
  }

  async onTerminal(
    event: CallTerminalEvent<TResponseObject, TRequestLike, TDecoded>,
  ): Promise<void> {
    await this.#adapters.onTerminal?.(event);
  }

  /**
   * Decodes, resolves context, dispatches one envelope, and converts the result.
   * Failures go through `toFailureResponse` once; a failing converter rejects.
   */
  async run(request: TRequestLike): Promise<TResponseObject> {
    let stage: CallFailureStage = "decode";
    let decoded: TDecoded | undefined;
    let context: TContext | undefined;
    try {
      decoded = await this.decode(request);
      await ignoreObserverFailure(async () => {
        await this.onDecoded({ request, decoded: decoded as TDecoded });
      });
      stage = "resolve";
      context = await this.resolveContext({ request, decoded });
      stage = "dispatch";
      const dispatched = await this.dispatch({ request, decoded, context });
      stage = "response";
      const response = await this.toResponse({ request, decoded, context, dispatched });
      await ignoreObserverFailure(async () => {
        await this.onTerminal({
          outcome: "responded",
          request,
          response,
          ...(decoded === undefined ? {} : { decoded }),
        });
      });
      return response;
    } catch (error) {
      const failure: CallFailureInput<TRequestLike, TDecoded, TContext> = {
        stage,
        error,
        request,
        ...(decoded === undefined ? {} : { decoded }),
        ...(context === undefined ? {} : { context }),
      };
      if (this.#adapters.toFailureResponse === undefined) {
        await ignoreObserverFailure(async () => {
          await this.onTerminal({
            outcome: "rejected",
            request,
            error,
            ...(decoded === undefined ? {} : { decoded }),
          });
        });
        throw error;
      }
      try {
        const response = await this.toFailureResponse(failure);
        await ignoreObserverFailure(async () => {
          await this.onTerminal({
            outcome: "responded",
            request,
            response,
            ...(decoded === undefined ? {} : { decoded }),
          });
        });
        return response;
      } catch (conversionError) {
        await ignoreObserverFailure(async () => {
          await this.onTerminal({
            outcome: "rejected",
            request,
            error: conversionError,
            ...(decoded === undefined ? {} : { decoded }),
          });
        });
        throw conversionError;
      }
    }
  }
}

/**
 * Thin entry around `Call.run` for callers that still pass a bare adapter map.
 */
export const runCall: RunCall = function runCall<
  TRequestLike,
  TDecoded,
  TContext,
  TResponseObject,
  TDispatched = TResponseObject,
>(
  request: TRequestLike,
  adapters: CallAdapters<TRequestLike, TDecoded, TContext, TResponseObject, TDispatched>,
): Promise<TResponseObject> {
  return new Call(adapters).run(request);
};
