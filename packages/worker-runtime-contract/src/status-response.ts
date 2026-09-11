import type { JsonResponseLike, StatusBearingResult } from "./type";

export function statusOfResult(result: StatusBearingResult): number {
  return result.ok ? 200 : result.error.status;
}

export function jsonResponseFromStatus<TResponse>(
  result: StatusBearingResult,
  response: JsonResponseLike<TResponse>,
): TResponse {
  return response.json(result, { status: statusOfResult(result) });
}
