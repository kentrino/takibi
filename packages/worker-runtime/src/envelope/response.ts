export type StatusBearingResult =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; error: Readonly<{ status: number }> }>;

export type JsonResponseLike<TResponse> = {
  json(body: unknown, init?: { readonly status?: number }): TResponse;
};

export function statusOfResult(result: StatusBearingResult): number {
  return result.ok ? 200 : result.error.status;
}

export function jsonResponseFromStatus<TResponse>(
  result: StatusBearingResult,
  response: JsonResponseLike<TResponse>,
): TResponse {
  return response.json(result, { status: statusOfResult(result) });
}
