import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installBridges } from './cv-bridges.js';
import { useCvPicker } from '../src/components/cv/useCvPicker.js';

afterEach(() => {
  vi.restoreAllMocks();
});

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

  it('pick() on a scanned PDF over the page bound reports too-many-pages', async () => {
    installBridges({
      cv: {
        selectAndRead: vi
          .fn()
          .mockResolvedValue({ status: 'scanned-pdf-unavailable', fileName: 'scan.pdf', pageCount: 40, reason: 'too-many-pages' }),
      },
    });
    const { result } = renderHook(() => useCvPicker());

    await act(async () => {
      await result.current.pick();
    });

    expect(result.current.state).toEqual({ phase: 'unavailable', fileName: 'scan.pdf', reason: 'too-many-pages' });
  });

  it('pick() on a scanned PDF with no attachment-capable provider reports no-provider', async () => {
    installBridges({
      cv: {
        selectAndRead: vi
          .fn()
          .mockResolvedValue({ status: 'scanned-pdf-unavailable', fileName: 'scan.pdf', pageCount: 3, reason: 'no-provider' }),
      },
    });
    const { result } = renderHook(() => useCvPicker());

    await act(async () => {
      await result.current.pick();
    });

    expect(result.current.state).toEqual({ phase: 'unavailable', fileName: 'scan.pdf', reason: 'no-provider' });
  });

  it('pick() where the user declined the native consent dialog returns to idle silently, like a cancelled picker dialog', async () => {
    installBridges({
      cv: {
        selectAndRead: vi
          .fn()
          .mockResolvedValue({ status: 'scanned-pdf-unavailable', fileName: 'scan.pdf', pageCount: 3, reason: 'declined' }),
      },
    });
    const { result } = renderHook(() => useCvPicker());

    await act(async () => {
      await result.current.pick();
    });

    expect(result.current.state).toEqual({ phase: 'idle' });
  });

  it('pick() on a scanned PDF the user already consented to (main already staged it) starts transcribing immediately, with no separate confirm step', async () => {
    const bridges = installBridges({
      cv: {
        selectAndRead: vi.fn().mockResolvedValue({
          status: 'scanned-pdf',
          fileName: 'scan.pdf',
          pageCount: 3,
          candidateId: 'candidate-4',
        }),
      },
    });
    const { result } = renderHook(() => useCvPicker());

    await act(async () => {
      await result.current.pick();
    });

    expect(result.current.state).toEqual({ phase: 'transcribing', fileName: 'scan.pdf' });
    await waitFor(() => expect(bridges.agentDock.createSession).toHaveBeenCalledTimes(1));
    const input = vi.mocked(bridges.agentDock.createSession).mock.calls[0]?.[0];
    // The provider and prompt this hook sends are placeholders: `daemon:create-session` overrides
    // both whenever `attachmentCandidateId` is present (issue #396's security review), precisely so
    // this hook cannot redirect a real consent to a different provider or a self-chosen prompt.
    // What actually matters, and what this asserts, is that the exact candidate id the user
    // consented to is the one that gets threaded through.
    expect(input?.attachmentCandidateId).toBe('candidate-4');
  });

  async function pickToTranscribing(candidateId = 'candidate-5') {
    const bridges = installBridges({
      cv: {
        selectAndRead: vi.fn().mockResolvedValue({
          status: 'scanned-pdf',
          fileName: 'scan.pdf',
          pageCount: 3,
          candidateId,
        }),
      },
    });
    const { result } = renderHook(() => useCvPicker());
    await act(async () => {
      await result.current.pick();
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
