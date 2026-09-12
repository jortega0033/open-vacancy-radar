export class ApplicationDataResetBusyError extends Error {
  constructor(message = 'wait for the active application task to finish before resetting data') {
    super(message);
    this.name = 'ApplicationDataResetBusyError';
  }
}

/** Prevents a reset from interleaving with application-data mutations. */
export class ApplicationDataResetGate {
  #activeMutations = 0;
  #resetting = false;

  get isResetting(): boolean {
    return this.#resetting;
  }

  async runMutation<T>(task: () => T | Promise<T>): Promise<T> {
    if (this.#resetting) {
      throw new ApplicationDataResetBusyError('application data is currently being reset; try again when it finishes');
    }
    this.#activeMutations += 1;
    try {
      return await task();
    } finally {
      this.#activeMutations -= 1;
    }
  }

  async runReset<T>(task: () => T | Promise<T>): Promise<T> {
    if (this.#resetting || this.#activeMutations > 0) throw new ApplicationDataResetBusyError();
    this.#resetting = true;
    try {
      return await task();
    } finally {
      this.#resetting = false;
    }
  }
}
