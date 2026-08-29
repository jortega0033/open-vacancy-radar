import { AsyncResource } from 'node:async_hooks';

type PendingTask<T> = {
  domain: string;
  run: () => Promise<T> | T;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason: unknown) => void;
  destroyContext: () => void;
};

export type RequestSchedulerSnapshot = {
  activeGlobal: number;
  activeByDomain: ReadonlyMap<string, number>;
  queued: number;
};

/** A shared FIFO scheduler with both global and hostname-level limits. */
export class RequestScheduler {
  readonly #globalLimit: number;
  readonly #perDomainLimit: number;
  readonly #queue: PendingTask<unknown>[] = [];
  readonly #activeByDomain = new Map<string, number>();
  #activeGlobal = 0;

  public constructor(globalLimit: number, perDomainLimit: number) {
    if (!Number.isSafeInteger(globalLimit) || globalLimit < 1) {
      throw new RangeError('globalLimit must be a positive integer');
    }
    if (!Number.isSafeInteger(perDomainLimit) || perDomainLimit < 1) {
      throw new RangeError('perDomainLimit must be a positive integer');
    }
    this.#globalLimit = globalLimit;
    this.#perDomainLimit = perDomainLimit;
  }

  public run<T>(domain: string, task: () => Promise<T> | T): Promise<T> {
    const normalizedDomain = domain.trim().toLowerCase().replace(/\.$/u, '');
    if (normalizedDomain.length === 0) {
      return Promise.reject(new TypeError('domain must not be empty'));
    }

    return new Promise<T>((resolve, reject) => {
      const context = new AsyncResource('RequestSchedulerTask');
      this.#queue.push({
        domain: normalizedDomain,
        run: context.bind(task),
        resolve: resolve as PendingTask<unknown>['resolve'],
        reject,
        destroyContext: () => context.emitDestroy(),
      });
      this.#drain();
    });
  }

  public snapshot(): RequestSchedulerSnapshot {
    return {
      activeGlobal: this.#activeGlobal,
      activeByDomain: new Map(this.#activeByDomain),
      queued: this.#queue.length,
    };
  }

  #drain(): void {
    while (this.#activeGlobal < this.#globalLimit) {
      const runnableIndex = this.#queue.findIndex(
        ({ domain }) => (this.#activeByDomain.get(domain) ?? 0) < this.#perDomainLimit,
      );
      if (runnableIndex < 0) return;

      const [pending] = this.#queue.splice(runnableIndex, 1);
      if (pending === undefined) return;

      this.#activeGlobal += 1;
      this.#activeByDomain.set(
        pending.domain,
        (this.#activeByDomain.get(pending.domain) ?? 0) + 1,
      );

      void Promise.resolve()
        .then(pending.run)
        .then(pending.resolve, pending.reject)
        .finally(() => {
          pending.destroyContext();
          this.#activeGlobal -= 1;
          const domainActive = (this.#activeByDomain.get(pending.domain) ?? 1) - 1;
          if (domainActive === 0) this.#activeByDomain.delete(pending.domain);
          else this.#activeByDomain.set(pending.domain, domainActive);
          this.#drain();
        });
    }
  }
}
