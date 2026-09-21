import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderCapabilities, ProviderStatus } from '@agent-dock/shared';
import { installBridges } from './cv-bridges.js';
import { useCvPicker } from '../src/components/cv/useCvPicker.js';

afterEach(() => {
  vi.restoreAllMocks();
});

const CAPABILITIES_NO_ATTACHMENTS: ProviderCapabilities = {
  resume: true,
  cancellation: true,
  tools: true,
  usage: true,
  thinking: true,
};

const CAPABILITIES_WITH_ATTACHMENTS: ProviderCapabilities = {
  ...CAPABILITIES_NO_ATTACHMENTS,
  attachments: true,
};

const CLAUDE_WITH_ATTACHMENTS: ProviderStatus = {
  id: 'claude',
  name: 'Claude Code',
  installed: true,
  authenticated: 'authenticated',
  capabilities: CAPABILITIES_WITH_ATTACHMENTS,
  availableModels: ['sonnet', 'opus'],
};

/**
 * `useEffectiveProvider`'s two settling effects (`workspace.getSettings`, `agentDock.listProviders`)
 * resolve asynchronously and are not otherwise observable from `useCvPicker`'s own return value.
 * `providerStatus` flips from `undefined` to a real object once they do (see that hook), which
 * changes `pick`'s `useCallback` identity -- the one externally visible signal that settling has
 * happened. Every test that calls `pick()` and cares about the provider-dependent branch waits for
 * this first, otherwise `pick()` would run against a stale, still-`undefined` `providerStatus`.
 */
async function waitForProviderToSettle(result: { current: { pick: () => Promise<void> } }) {
  const initialPick = result.current.pick;
  await waitFor(() => expect(result.current.pick).not.toBe(initialPick));
}

describe('useCvPicker', () => {
  it('pick() on an ok result goes straight to done, tagged as text_layer', async () => {
    installBridges({
      cv: { selectAndRead: vi.fn().mockResolvedValue({ status: 'ok', fileName: 'cv.pdf', text: 'Angular architect.' }) },
    });
    const { result } = renderHook(() => useCvPicker());

    await act(async () => {
      await result.current.pick();
    });

    expect(result.current.state).toEqual({
      phase: 'done',
      result: { fileName: 'cv.pdf', text: 'Angular architect.', textSource: 'text_layer' },
    });
  });

  it('pick() resolving null (dialog cancelled) returns to idle', async () => {
    installBridges({ cv: { selectAndRead: vi.fn().mockResolvedValue(null) } });
    const { result } = renderHook(() => useCvPicker());

    await act(async () => {
      await result.current.pick();
    });

    expect(result.current.state).toEqual({ phase: 'idle' });
  });

  it('pick() rejecting surfaces an error with the IPC prefix stripped', async () => {
    installBridges({
      cv: {
        selectAndRead: vi
          .fn()
          .mockRejectedValue(new Error("Error invoking remote method 'cv:select-and-read': Error: disk read failed")),
      },
    });
    const { result } = renderHook(() => useCvPicker());

    await act(async () => {
      await result.current.pick();
    });

    expect(result.current.state.phase).toBe('error');
    const message = (result.current.state as { message: string }).message;
    expect(message).toBe('disk read failed');
    expect(message).not.toContain('invoking remote method');
  });

  it('pick() on a scanned PDF over the page bound (no candidateId) reports too-many-pages', async () => {
    installBridges({
      cv: {
        selectAndRead: vi
          .fn()
          .mockResolvedValue({ status: 'scanned-pdf', fileName: 'scan.pdf', pageCount: 40, tooManyPages: true }),
      },
    });
    const { result } = renderHook(() => useCvPicker());

    await act(async () => {
      await result.current.pick();
    });

    expect(result.current.state).toEqual({ phase: 'unavailable', fileName: 'scan.pdf', reason: 'too-many-pages' });
  });

  it('pick() on a scanned PDF within the page bound but no attachment-capable provider reports no-provider and discards the staged candidate', async () => {
    const bridges = installBridges({
      cv: {
        selectAndRead: vi.fn().mockResolvedValue({
          status: 'scanned-pdf',
          fileName: 'scan.pdf',
          pageCount: 3,
          tooManyPages: false,
          candidateId: 'candidate-1',
        }),
      },
      // installBridges' default CLAUDE_INSTALLED has no `attachments` capability at all.
    });
    const { result } = renderHook(() => useCvPicker());
    await waitForProviderToSettle(result);

    await act(async () => {
      await result.current.pick();
    });

    expect(result.current.state).toEqual({ phase: 'unavailable', fileName: 'scan.pdf', reason: 'no-provider' });
    expect(bridges.cv.discardStagedTranscription).toHaveBeenCalledWith('candidate-1');
  });

  it('pick() on a scanned PDF with an attachment-capable provider offers consent instead', async () => {
    installBridges({
      agentDock: { listProviders: vi.fn().mockResolvedValue([CLAUDE_WITH_ATTACHMENTS]) },
      cv: {
        selectAndRead: vi.fn().mockResolvedValue({
          status: 'scanned-pdf',
          fileName: 'scan.pdf',
          pageCount: 3,
          tooManyPages: false,
          candidateId: 'candidate-2',
        }),
      },
    });
    const { result } = renderHook(() => useCvPicker());
    await waitForProviderToSettle(result);

    await act(async () => {
      await result.current.pick();
    });

    expect(result.current.state).toEqual({ phase: 'consent', fileName: 'scan.pdf', providerLabel: 'Claude Code' });
  });

  it('declineTranscription from consent returns to idle and discards the staged candidate', async () => {
    const bridges = installBridges({
      agentDock: { listProviders: vi.fn().mockResolvedValue([CLAUDE_WITH_ATTACHMENTS]) },
      cv: {
        selectAndRead: vi.fn().mockResolvedValue({
          status: 'scanned-pdf',
          fileName: 'scan.pdf',
          pageCount: 3,
          tooManyPages: false,
          candidateId: 'candidate-3',
        }),
      },
    });
    const { result } = renderHook(() => useCvPicker());
    await waitForProviderToSettle(result);
    await act(async () => {
      await result.current.pick();
    });
    expect(result.current.state.phase).toBe('consent');

    act(() => {
      result.current.declineTranscription();
    });

    expect(result.current.state).toEqual({ phase: 'idle' });
    expect(bridges.cv.discardStagedTranscription).toHaveBeenCalledWith('candidate-3');
  });

  it('confirmTranscription starts the agent session with the candidate id and resolved provider, and moves to transcribing', async () => {
    const bridges = installBridges({
      agentDock: { listProviders: vi.fn().mockResolvedValue([CLAUDE_WITH_ATTACHMENTS]) },
      cv: {
        selectAndRead: vi.fn().mockResolvedValue({
          status: 'scanned-pdf',
          fileName: 'scan.pdf',
          pageCount: 3,
          tooManyPages: false,
          candidateId: 'candidate-4',
        }),
      },
    });
    const { result } = renderHook(() => useCvPicker());
    await waitForProviderToSettle(result);
    await act(async () => {
      await result.current.pick();
    });
    expect(result.current.state.phase).toBe('consent');

    await act(async () => {
      result.current.confirmTranscription();
    });

    expect(result.current.state).toEqual({ phase: 'transcribing', fileName: 'scan.pdf' });
    await waitFor(() => expect(bridges.agentDock.createSession).toHaveBeenCalledTimes(1));
    const input = vi.mocked(bridges.agentDock.createSession).mock.calls[0]?.[0];
    expect(input?.attachmentCandidateId).toBe('candidate-4');
    expect(input?.provider).toBe('claude');
  });

  async function pickToTranscribing(candidateId = 'candidate-5') {
    const bridges = installBridges({
      agentDock: { listProviders: vi.fn().mockResolvedValue([CLAUDE_WITH_ATTACHMENTS]) },
      cv: {
        selectAndRead: vi.fn().mockResolvedValue({
          status: 'scanned-pdf',
          fileName: 'scan.pdf',
          pageCount: 3,
          tooManyPages: false,
          candidateId,
        }),
      },
    });
    const { result } = renderHook(() => useCvPicker());
    await waitForProviderToSettle(result);
    await act(async () => {
      await result.current.pick();
    });
    await act(async () => {
      result.current.confirmTranscription();
    });
    await waitFor(() => expect(bridges.agentDock.createSession).toHaveBeenCalledTimes(1));
    return { result, bridges };
  }

  it('accumulates streamed text and moves to review on session.completed', async () => {
    const { result, bridges } = await pickToTranscribing();

    act(() => {
      bridges.emit('sess-cv-1', { type: 'assistant.message', text: '  Jake Ortega, Angular architect.  ' });
    });
    act(() => {
      bridges.emit('sess-cv-1', { type: 'session.completed' });
    });

    await waitFor(() => expect(result.current.state.phase).toBe('review'));
    expect(result.current.state).toEqual({ phase: 'review', fileName: 'scan.pdf' });
    expect(result.current.reviewText).toBe('Jake Ortega, Angular architect.');
  });

  it('confirmReview uses the (possibly edited) reviewText and tags the result as ai_transcription', async () => {
    const { result, bridges } = await pickToTranscribing();

    act(() => {
      bridges.emit('sess-cv-1', { type: 'assistant.message', text: 'Original transcription.' });
    });
    act(() => {
      bridges.emit('sess-cv-1', { type: 'session.completed' });
    });
    await waitFor(() => expect(result.current.state.phase).toBe('review'));

    act(() => {
      result.current.setReviewText('Corrected transcription.');
    });
    act(() => {
      result.current.confirmReview();
    });

    expect(result.current.state).toEqual({
      phase: 'done',
      result: { fileName: 'scan.pdf', text: 'Corrected transcription.', textSource: 'ai_transcription' },
    });
  });

  it('an empty-output transcription (no assistant.message ever sent) surfaces useAgentRun\'s own empty-output error', async () => {
    const { result, bridges } = await pickToTranscribing();

    act(() => {
      bridges.emit('sess-cv-1', { type: 'session.completed' });
    });

    await waitFor(() => expect(result.current.state.phase).toBe('error'));
    expect((result.current.state as { message: string }).message).toBe(
      'the agent finished without returning any text',
    );
  });

  it('an oversized transcription is rejected with a message naming the character bound, and never reaches review', async () => {
    const { result, bridges } = await pickToTranscribing();
    const hugeText = 'a'.repeat(2_000_001);

    act(() => {
      bridges.emit('sess-cv-1', { type: 'assistant.message', text: hugeText });
    });
    act(() => {
      bridges.emit('sess-cv-1', { type: 'session.completed' });
    });

    await waitFor(() => expect(result.current.state.phase).toBe('error'));
    const message = (result.current.state as { message: string }).message;
    expect(message).toContain('2,000,000 characters');
    expect(result.current.state.phase).not.toBe('review');
  });

  it('cancel() from transcribing cancels the session and returns to idle without waiting for a cancelled event', async () => {
    const { result, bridges } = await pickToTranscribing();

    act(() => {
      result.current.cancel();
    });

    expect(result.current.state).toEqual({ phase: 'idle' });
    expect(bridges.agentDock.cancelSession).toHaveBeenCalledWith('sess-cv-1');
  });

  it('a session.failed event while transcribing surfaces the session\'s own failure message', async () => {
    const { result, bridges } = await pickToTranscribing();

    act(() => {
      bridges.emit('sess-cv-1', { type: 'session.failed', message: 'the provider CLI crashed' });
    });

    await waitFor(() => expect(result.current.state.phase).toBe('error'));
    expect((result.current.state as { message: string }).message).toBe('the provider CLI crashed');
  });

  it('reset() from a terminal phase returns to idle', async () => {
    installBridges({
      cv: { selectAndRead: vi.fn().mockResolvedValue({ status: 'ok', fileName: 'cv.pdf', text: 'hello' }) },
    });
    const { result } = renderHook(() => useCvPicker());

    await act(async () => {
      await result.current.pick();
    });
    expect(result.current.state.phase).toBe('done');

    act(() => {
      result.current.reset();
    });

    expect(result.current.state).toEqual({ phase: 'idle' });
  });
});
