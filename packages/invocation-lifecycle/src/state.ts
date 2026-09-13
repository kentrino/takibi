import { InvocationLifecycleConfigurationError, InvocationLifecycleStateError } from "./error";
import {
  toObservedInput,
  type InternalInvocationFailure,
  type InternalInvocationFailureStage,
  type InternalInvocationNotification,
  type InternalInvocationPhase,
  type InternalInvocationRuntime,
  type InternalInvocationSettlement,
  type InternalInvocationTransaction,
  type InternalInvocationTypeMap,
  type InvocationCurrentContext,
  type InvocationAdapterResult,
  type InvocationInputState,
  type InvocationObserverEvent,
  type InvocationPlan,
  type InvocationPlanningView,
  type InvocationRequest,
  type InvocationResult,
} from "./type";

const UNSET = Symbol("takibi.invocation.unset");

function projectRuntime<T extends InternalInvocationTypeMap>(
  runtime: InternalInvocationRuntime<T>,
): Omit<InternalInvocationRuntime<T>, "storage"> {
  const descriptors = Object.getOwnPropertyDescriptors(runtime);
  Reflect.deleteProperty(descriptors, "storage");
  const boundCapabilities = new WeakMap<object, object>();
  for (const descriptor of Object.values(descriptors)) {
    if (typeof descriptor.value !== "function") continue;
    const capability = descriptor.value;
    const cached = boundCapabilities.get(capability);
    const bound = cached ?? capability.bind(runtime);
    boundCapabilities.set(capability, bound);
    boundCapabilities.set(bound, bound);
    descriptor.value = bound;
  }
  const runtimeView = Object.create(Object.getPrototypeOf(runtime), descriptors);
  return new Proxy(runtimeView, {
    get(target, property) {
      if (property === "storage") return undefined;
      const value = Reflect.get(target, property, runtime);
      if (typeof value !== "function") return value;
      const cached = boundCapabilities.get(value);
      if (cached !== undefined) return cached;
      const bound = value.bind(runtime);
      boundCapabilities.set(value, bound);
      return bound;
    },
    has(target, property) {
      return property !== "storage" && Reflect.has(target, property);
    },
  });
}

/**
 * The single mutable lifecycle object for one invocation. Payload references in
 * views are shared; the carrier fields themselves are hidden by JavaScript
 * private fields and are changed only by semantic transitions.
 */
export class InvocationState<T extends InternalInvocationTypeMap> {
  #phase: InternalInvocationPhase = "created";
  readonly #wireInvocation: T["wireInvocation"];
  readonly #runtime: InternalInvocationRuntime<T>;
  readonly #runtimeView: Omit<InternalInvocationRuntime<T>, "storage">;
  #invocation: T["invocation"] | typeof UNSET = UNSET;
  #plan: InvocationPlan<T> | typeof UNSET = UNSET;
  readonly #baseContext: T["context"];
  #context: InvocationCurrentContext<T>;
  #input: InvocationInputState<T["rawInput"], T["input"]> = {
    status: "not-applicable",
  };
  #transaction: InternalInvocationTransaction = "none";
  #settlement: InternalInvocationSettlement<T["result"], T["failure"]> | typeof UNSET = UNSET;
  #notification: InternalInvocationNotification | typeof UNSET = UNSET;
  readonly #runtimeChecks: boolean;

  constructor(
    request: InvocationRequest<T>,
    runtime: InternalInvocationRuntime<T>,
    runtimeChecks = true,
  ) {
    this.#wireInvocation = request.wireInvocation;
    this.#baseContext = request.context;
    this.#context = request.context;
    this.#runtime = runtime;
    this.#runtimeView = projectRuntime<T>(runtime);
    this.#runtimeChecks = runtimeChecks;
  }

  start(): void {
    this.#assertPhase("created");
    this.#phase = "running";
  }

  initializationView(): Readonly<{ wireInvocation: T["wireInvocation"] }> {
    this.#assertPhase("running");
    return { wireInvocation: this.#wireInvocation };
  }

  acceptInvocation(invocation: T["invocation"]): void {
    this.#assertPhase("running");
    if (this.#invocation !== UNSET)
      throw new InvocationLifecycleStateError("Invocation is initialized");
    this.#invocation = invocation;
  }

  acceptRawInput(rawInput: T["rawInput"]): void {
    this.#assertPhase("running");
    this.#initializedInvocation();
    if (this.#input.status !== "not-applicable") {
      throw new InvocationLifecycleStateError("Invocation input is already initialized");
    }
    this.#input = { status: "raw", value: rawInput };
  }

  planningView(): InvocationPlanningView<T> {
    this.#assertPhase("running");
    const invocation = this.#initializedInvocation();
    return {
      wireInvocation: this.#wireInvocation,
      invocation,
      runtime: this.#runtime,
      context: this.#baseContext,
      input: this.#input,
    };
  }

  acceptPlan(result: InvocationAdapterResult<T, InvocationPlan<T>>): void {
    this.#assertPhase("running");
    this.#initializedInvocation();
    if (this.#plan !== UNSET) {
      throw new InvocationLifecycleStateError("Invocation already has a plan");
    }
    this.#applyUpdates(result.updates);
    if (result.outcome === "failed") throw result.error;
    this.#plan = result.value;
  }

  executionView(): import("./type").InvocationExecutionView<T> {
    this.#assertPhase("running");
    const invocation = this.#initializedInvocation();
    const plan = this.#acceptedPlan();
    return {
      baseContext: this.#baseContext,
      context: this.#context,
      invocation,
      plan,
      input: this.#input,
      runtime: this.#runtimeView,
    };
  }

  acceptAdapterResult<TValue>(result: InvocationAdapterResult<T, TValue>): TValue {
    this.#assertPhase("running");
    this.#acceptedPlan();
    this.#applyUpdates(result.updates);
    if (result.outcome === "failed") throw result.error;
    return result.value;
  }

  storage(): T["runtime"]["storage"] {
    this.#assertPhase("running");
    this.#acceptedPlan();
    return this.#runtime.storage;
  }

  beginTransaction(): void {
    this.#assertPhase("running");
    this.#acceptedPlan();
    if (this.#transaction !== "none") {
      throw new InvocationLifecycleConfigurationError(
        "Invocation transaction is already in progress",
      );
    }
    this.#transaction = "open";
  }

  completeTransaction(): void {
    this.#assertPhase("running");
    if (this.#transaction !== "open") {
      throw new InvocationLifecycleConfigurationError("Invocation transaction is not open");
    }
    this.#transaction = "committed";
  }

  abortTransaction(outcome: "rolled-back" | "unknown" = "unknown"): void {
    this.#assertPhase("running");
    if (this.#transaction !== "open") {
      throw new InvocationLifecycleConfigurationError("Invocation transaction is not open");
    }
    this.#transaction = outcome;
  }

  succeed(result: T["result"]): void {
    this.#assertCanSettle();
    this.#initializedInvocation();
    this.#acceptedPlan();
    this.#settlement = { outcome: "succeeded", result };
    this.#phase = "settled";
  }

  fail(
    stage: InternalInvocationFailureStage,
    failure: InternalInvocationFailure<T["failure"]>,
  ): void {
    this.#assertCanSettle();
    this.#settlement = { outcome: "failed", stage, failure };
    this.#phase = "settled";
  }

  observerEvent(): InvocationObserverEvent<T> {
    this.#assertPhase("settled");
    if (this.#settlement === UNSET)
      throw new InvocationLifecycleStateError("Invocation is not settled");
    const plan = this.#plan === UNSET ? undefined : this.#plan;
    const common = {
      phase: "settled" as const,
      context: this.#context,
      input: toObservedInput(this.#input),
      transactionBoundary: plan?.transactionBoundary,
      transaction: this.#settledTransaction(),
    };
    if (this.#settlement.outcome === "succeeded") {
      const invocation = this.#initializedInvocation();
      return Object.freeze({
        ...common,
        outcome: "succeeded",
        invocation,
        result: this.#settlement.result,
      });
    }
    return Object.freeze({
      ...common,
      outcome: "failed",
      invocation: this.#invocation === UNSET ? undefined : this.#invocation,
      stage: this.#settlement.stage,
      failure: this.#settlement.failure,
    });
  }

  beginNotification(): boolean {
    if (this.#phase === "notified" && !this.#runtimeChecks) return false;
    this.#assertPhaseAlways("settled");
    if (this.#notification !== UNSET) {
      throw new InvocationLifecycleStateError("Invocation is already notified");
    }
    this.#phase = "notifying";
    return true;
  }

  finishNotification(notification: InternalInvocationNotification): void {
    this.#assertPhaseAlways("notifying");
    if (this.#notification !== UNSET) {
      throw new InvocationLifecycleStateError("Invocation notification is already recorded");
    }
    this.#notification = notification;
    this.#phase = "notified";
  }

  result(): InvocationResult<T> {
    this.#assertPhaseAlways("notified");
    const settlement = this.#settlement;
    const notification = this.#notification;
    if (settlement === UNSET || notification === UNSET) {
      throw new InvocationLifecycleStateError("Invocation terminal state is incomplete");
    }
    const common = {
      phase: "notified",
      wireInvocation: this.#wireInvocation,
      runtime: this.#runtime,
      context: this.#context,
      input: this.#input,
      effects: { transaction: this.#settledTransaction() },
      notification,
    } as const;
    if (settlement.outcome === "succeeded") {
      const invocation = this.#invocation;
      const plan = this.#plan;
      if (invocation === UNSET || plan === UNSET) {
        throw new InvocationLifecycleStateError(
          "Successful invocation terminal state is incomplete",
        );
      }
      return Object.freeze({
        ...common,
        invocation,
        plan,
        settlement,
      });
    }
    return Object.freeze({
      ...common,
      invocation: this.#invocation === UNSET ? undefined : this.#invocation,
      plan: this.#plan === UNSET ? undefined : this.#plan,
      settlement,
    });
  }

  #applyUpdates(updates: import("./type").InvocationUpdates<T> | undefined): void {
    if (updates === undefined) return;
    if (Object.hasOwn(updates, "context") && updates.context !== undefined) {
      this.#context = updates.context;
    }
    if (Object.hasOwn(updates, "input") && updates.input !== undefined) {
      this.#input = updates.input;
    }
  }

  #settledTransaction(): Exclude<InternalInvocationTransaction, "open"> {
    if (this.#transaction === "open") {
      throw new InvocationLifecycleStateError("Invocation transaction is still open");
    }
    return this.#transaction;
  }

  #assertCanSettle(): void {
    this.#assertPhase("running");
    if (this.#settlement !== UNSET)
      throw new InvocationLifecycleStateError("Invocation is already settled");
    if (this.#transaction === "open") this.#transaction = "unknown";
  }

  #initializedInvocation(): T["invocation"] {
    if (this.#invocation === UNSET) {
      throw new InvocationLifecycleStateError("Invocation is not initialized");
    }
    return this.#invocation;
  }

  #acceptedPlan(): InvocationPlan<T> {
    if (this.#plan === UNSET) {
      throw new InvocationLifecycleStateError("Invocation has no plan");
    }
    return this.#plan;
  }

  #assertPhase(expected: InternalInvocationPhase): void {
    if (this.#runtimeChecks) this.#assertPhaseAlways(expected);
  }

  #assertPhaseAlways(expected: InternalInvocationPhase): void {
    if (this.#phase !== expected) {
      throw new InvocationLifecycleStateError(
        `Expected invocation phase ${expected}, got ${this.#phase}`,
      );
    }
  }
}
