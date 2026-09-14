import { describe, expect, it } from 'vitest';
import { ApplicationDataResetGate } from '../electron/application-data-reset-gate.js';

describe('ApplicationDataResetGate', () => {
  it('refuses reset while a mutation is active', async () => {
    const gate = new ApplicationDataResetGate();
    let release!: () => void;
    const mutation = gate.runMutation(() => new Promise<void>((resolve) => (release = resolve)));

    await expect(gate.runReset(() => undefined)).rejects.toThrow(/active application task/i);
    release();
    await mutation;
  });

  it('refuses mutations until reset finishes and permits them afterwards', async () => {
    const gate = new ApplicationDataResetGate();
    let release!: () => void;
    const reset = gate.runReset(() => new Promise<void>((resolve) => (release = resolve)));

    await expect(gate.runMutation(() => undefined)).rejects.toThrow(/currently being reset/i);
    release();
    await reset;
    await expect(gate.runMutation(() => 'ok')).resolves.toBe('ok');
  });
});
