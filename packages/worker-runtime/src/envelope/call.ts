import type { MaybePromise } from "@takibi/invocation-lifecycle";

export type CallFailureStage = "decode" | "resolve" | "dispatch" | "response";

export type CallFailureInput<TRequestLike, TDecoded, TContext> = Readonly<
  { error: unknown; request: TRequestLike } & (
    | { stage: "decode"; decoded?: never; context?: never }
    | { stage: "resolve"; decoded: TDecoded; context?: never }
    | { stage: "dispatch" | "response"; decoded: TDecoded; context: TContext }
  )
>;

export type CallTerminalEvent<TResponseObject, TRequestLike = unknown, TDecoded = unknown> =
  | Readonly<{
      outcome: "responded";
      request: TRequestLike;
      decoded?: TDecoded;
      response: TResponseObject;
    }>
  | Readonly<{
      outcome: "rejected";
      request: TRequestLike;
      decoded?: TDecoded;
      error: unknown;
    }>;

export type CallAdapters<
  TRequestLike,
  TDecoded,
  TContext,
  TResponseObject,
  TDispatched = TResponseObject,
> = {
  callDecode: (request: TRequestLike) => MaybePromise<TDecoded>;
  callResolveContext: (input: {
    request: TRequestLike;
    decoded: TDecoded;
  }) => MaybePromise<TContext>;
  callDispatch: (input: {
    request: TRequestLike;
    decoded: TDecoded;
    context: TContext;
  }) => MaybePromise<TDispatched>;
  callToResponse: (input: {
    request: TRequestLike;
    decoded: TDecoded;
    context: TContext;
    dispatched: TDispatched;
  }) => MaybePromise<TResponseObject>;
  callToFailureResponse?: (
    failure: CallFailureInput<TRequestLike, TDecoded, TContext>,
  ) => MaybePromise<TResponseObject>;
  callOnDecoded?: (input: { request: TRequestLike; decoded: TDecoded }) => MaybePromise<void>;
  callOnTerminal?: (
    event: CallTerminalEvent<TResponseObject, TRequestLike, TDecoded>,
  ) => MaybePromise<void>;
};

export type EnvelopeAdapterMap<
  TRequestLike,
  TDecoded,
  TContext,
  TResponseObject,
  TDispatched = TResponseObject,
> = CallAdapters<TRequestLike, TDecoded, TContext, TResponseObject, TDispatched> & {
  call: Call<TRequestLike, TDecoded, TContext, TResponseObject, TDispatched>;
};

export const ENVELOPE_CALL_ADAPTER_KEYS = [
  "callDecode",
  "callResolveContext",
  "callDispatch",
  "callToResponse",
  "callToFailureResponse",
  "callOnDecoded",
  "callOnTerminal",
] as const;

export type EnvelopeAdapterGraph = {
  readonly [K in (typeof ENVELOPE_CALL_ADAPTER_KEYS)[number] | "call"]: readonly (
    | (typeof ENVELOPE_CALL_ADAPTER_KEYS)[number]
    | "call"
  )[];
};

export const ENVELOPE_ADAPTER_GRAPH = {
  callDecode: [],
  callResolveContext: [],
  callDispatch: [],
  callToResponse: [],
  callToFailureResponse: [],
  callOnDecoded: [],
  callOnTerminal: [],
  call: ENVELOPE_CALL_ADAPTER_KEYS,
} as const satisfies EnvelopeAdapterGraph;

/**
 * Envelope Call runner. Constructor slots are the envelope adapter map.
 * `run` owns progression; observation failures are isolated here so callers
 * do not wrap each notify site.
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
    return this.#adapters.callDecode(request);
  }

  async resolveContext(input: { request: TRequestLike; decoded: TDecoded }): Promise<TContext> {
    return this.#adapters.callResolveContext(input);
  }

  async dispatch(input: {
    request: TRequestLike;
    decoded: TDecoded;
    context: TContext;
  }): Promise<TDispatched> {
    return this.#adapters.callDispatch(input);
  }

  async toResponse(input: {
    request: TRequestLike;
    decoded: TDecoded;
    context: TContext;
    dispatched: TDispatched;
  }): Promise<TResponseObject> {
    return this.#adapters.callToResponse(input);
  }

  async toFailureResponse(
    failure: CallFailureInput<TRequestLike, TDecoded, TContext>,
  ): Promise<TResponseObject> {
    if (this.#adapters.callToFailureResponse === undefined) {
      throw failure.error;
    }
    return this.#adapters.callToFailureResponse(failure);
  }

  async onDecoded(input: { request: TRequestLike; decoded: TDecoded }): Promise<void> {
    await this.#adapters.callOnDecoded?.(input);
  }

  async onTerminal(
    event: CallTerminalEvent<TResponseObject, TRequestLike, TDecoded>,
  ): Promise<void> {
    await this.#adapters.callOnTerminal?.(event);
  }

  async #observe(work: MaybePromise<void>): Promise<void> {
    try {
      await work;
    } catch {
      // Observation must not replace the Call result or re-dispatch.
    }
  }

  /**
   * Decodes, resolves context, dispatches one envelope, and converts the result.
   * Failures go through `toFailureResponse` once; a failing converter rejects.
   */
  async run(request: TRequestLike): Promise<TResponseObject> {
    let decoded: TDecoded;
    try {
      decoded = await this.decode(request);
    } catch (error) {
      return await this.#fail({ stage: "decode", error, request });
    }
    return this.#runDecoded(request, decoded);
  }

  async #runDecoded(request: TRequestLike, decoded: TDecoded): Promise<TResponseObject> {
    await this.#observe(this.onDecoded({ request, decoded }));
    let progress: { stage: "resolve" } | { stage: "dispatch" | "response"; context: TContext } = {
      stage: "resolve",
    };
    try {
      const context = await this.resolveContext({ request, decoded });
      progress = { stage: "dispatch", context };
      const dispatched = await this.dispatch({ request, decoded, context });
      progress = { stage: "response", context };
      const response = await this.toResponse({ request, decoded, context, dispatched });
      await this.#observe(this.onTerminal({ outcome: "responded", request, decoded, response }));
      return response;
    } catch (error) {
      return await this.#fail({ ...progress, error, request, decoded });
    }
  }

  async #fail(
    failure: CallFailureInput<TRequestLike, TDecoded, TContext>,
  ): Promise<TResponseObject> {
    const terminal = {
      request: failure.request,
      ...(failure.stage === "decode" ? {} : { decoded: failure.decoded }),
    };
    if (this.#adapters.callToFailureResponse === undefined) {
      await this.#observe(
        this.onTerminal({ outcome: "rejected", error: failure.error, ...terminal }),
      );
      throw failure.error;
    }
    try {
      const response = await this.toFailureResponse(failure);
      await this.#observe(this.onTerminal({ outcome: "responded", response, ...terminal }));
      return response;
    } catch (conversionError) {
      await this.#observe(
        this.onTerminal({ outcome: "rejected", error: conversionError, ...terminal }),
      );
      throw conversionError;
    }
  }
}

/**
 * Thin entry around `Call.run` for callers that still pass a bare adapter map.
 */
export function runCall<
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
}
