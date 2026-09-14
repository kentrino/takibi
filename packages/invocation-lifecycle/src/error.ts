export class InvocationLifecycleStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvocationLifecycleStateError";
  }
}

export class InvocationLifecycleConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvocationLifecycleConfigurationError";
  }
}
