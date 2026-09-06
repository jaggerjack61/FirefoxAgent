/** Stop awaiting an operation even when the underlying API ignores AbortSignal.
 * Late results/rejections are consumed, never allowed to resume the caller.
 */
export function abortable<T>(signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException("Stopped", "AbortError"));
      return;
    }
    const abort = () => reject(signal?.reason ?? new DOMException("Stopped", "AbortError"));
    signal?.addEventListener("abort", abort, { once: true });
    Promise.resolve()
      .then(() => {
        signal?.throwIfAborted();
        return operation();
      })
      .then(
        (value) => {
          signal?.removeEventListener("abort", abort);
          if (signal?.aborted) abort();
          else resolve(value);
        },
        (error: unknown) => {
          signal?.removeEventListener("abort", abort);
          reject(error);
        },
      );
  });
}

export function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}
