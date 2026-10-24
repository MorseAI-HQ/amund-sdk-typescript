/**
 * Helpers for wrapping a provider SDK call without changing what it returns.
 *
 * The Anthropic and OpenAI SDKs' `create()` return an `APIPromise`: a Promise
 * with extra methods (`withResponse()`, `asResponse()`) that callers and the
 * SDKs themselves rely on (`messages.stream()` calls
 * `create(...).withResponse()`). A wrapper that returns a plain Promise breaks
 * those callers (MHQ-1415). `_thenUnwrap` maps the resolved value while keeping
 * the APIPromise shape; fakes and very old SDKs without it fall back to `.then`.
 */

interface ApiPromiseLike<T> extends PromiseLike<T> {
  _thenUnwrap?: <U>(transform: (data: T) => U) => PromiseLike<U>;
}

/** Map a provider promise's value, keeping its `APIPromise` shape when it has one. */
export function mapKeepingShape<T, U>(
  p: PromiseLike<T>,
  transform: (data: T) => U,
): PromiseLike<U> {
  const api = p as ApiPromiseLike<T>;
  if (typeof api._thenUnwrap === "function") return api._thenUnwrap(transform);
  return p.then(transform);
}

/** Observe a rejection without handling it for the caller. */
export function onRejected(p: PromiseLike<unknown>, handler: (err: unknown) => void): void {
  try {
    // `p.then` directly (not `Promise.resolve(p)`), so this handler runs before
    // the caller's own `await` resumes and can still close the span in-trace.
    p.then(undefined, (err: unknown) => {
      try {
        handler(err);
      } catch {
        // swallow — telemetry must never break the caller
      }
    });
  } catch {
    // swallow
  }
}

/**
 * Proxy an async-iterable stream so iterating it feeds `onEvent` and `onFinish`
 * runs exactly once: on exhaustion, on `return()` (the caller broke out), or on
 * an error. A value that is not async-iterable is returned untouched and
 * `onFinish` runs immediately.
 */
export function wrapEventStream<S extends object>(
  stream: S,
  onEvent: (event: unknown) => void,
  onFinish: (error: unknown) => void,
): S {
  const iterFn = (stream as Record<symbol, unknown>)[Symbol.asyncIterator];
  if (typeof iterFn !== "function") {
    onFinish(undefined);
    return stream;
  }
  let finished = false;
  const finish = (error: unknown): void => {
    if (finished) return;
    finished = true;
    try {
      onFinish(error);
    } catch {
      // swallow — telemetry must never break the caller
    }
  };
  return new Proxy(stream, {
    get(target, prop, receiver) {
      if (prop === Symbol.asyncIterator) {
        return function tracedIterator(): AsyncIterator<unknown> {
          const it = (iterFn as () => AsyncIterator<unknown>).call(target);
          const wrapped: AsyncIterator<unknown> & AsyncIterable<unknown> = {
            async next(...args: [] | [unknown]) {
              let result: IteratorResult<unknown>;
              try {
                result = await it.next(...args);
              } catch (err) {
                finish(err);
                throw err;
              }
              if (result.done) finish(undefined);
              else {
                try {
                  onEvent(result.value);
                } catch {
                  // swallow — telemetry must never break the caller's stream
                }
              }
              return result;
            },
            async return(value?: unknown) {
              finish(undefined);
              if (typeof it.return === "function") return it.return(value);
              return { done: true, value };
            },
            async throw(err?: unknown) {
              finish(err);
              if (typeof it.throw === "function") return it.throw(err);
              throw err;
            },
            [Symbol.asyncIterator]() {
              return wrapped;
            },
          };
          return wrapped;
        };
      }
      const value = Reflect.get(target, prop, receiver);
      if (typeof value === "function") return (value as (...a: unknown[]) => unknown).bind(target);
      return value;
    },
  });
}
