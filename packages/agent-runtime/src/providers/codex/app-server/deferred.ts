/**
 * A promise whose resolve/reject can be called from outside its executor, and which silently
 * ignores a second settle attempt rather than throwing -- exactly what request/response
 * correlation over an async wire protocol needs (`rpc.ts` settles a pending request's `Deferred`
 * from whichever of "the response arrived" / "the write failed" / "the peer failed" happens first,
 * and the other two must be no-ops). Ported verbatim from upstream AgentDock.
 */
export interface Deferred<T> {
  promise: Promise<T>;
  settled: boolean;
  resolve(value: T): void;
  reject(error: unknown): void;
}

export function deferred<T>(): Deferred<T> {
  let settled = false;
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    get settled() {
      return settled;
    },
    resolve(value: T): void {
      if (settled) return;
      settled = true;
      resolvePromise(value);
    },
    reject(error: unknown): void {
      if (settled) return;
      settled = true;
      rejectPromise(error);
    },
  };
}
