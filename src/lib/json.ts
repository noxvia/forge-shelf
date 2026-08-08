/**
 * Prisma returns BigInt for file sizes, which JSON.stringify refuses to
 * serialise. These helpers keep that detail out of every route handler.
 */

export function jsonReplacer(_key: string, value: unknown) {
  return typeof value === 'bigint' ? value.toString() : value;
}

export function ok(data: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(data, jsonReplacer), {
    ...init,
    headers: { 'content-type': 'application/json; charset=utf-8', ...init?.headers },
  });
}

export function fail(message: string, status = 400, extra?: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ error: message, ...extra }, jsonReplacer), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

/** Wraps a route handler so thrown errors become clean 4xx/5xx JSON. */
export function handler<A extends unknown[]>(
  fn: (...args: A) => Promise<Response>,
): (...args: A) => Promise<Response> {
  return async (...args: A) => {
    try {
      return await fn(...args);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = err instanceof HttpError ? err.status : 500;
      if (status >= 500) console.error('[api]', err);
      return fail(message, status);
    }
  };
}

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}
