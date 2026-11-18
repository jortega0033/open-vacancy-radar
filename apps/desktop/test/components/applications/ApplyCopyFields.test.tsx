import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApplyCopyFields } from '../../../src/components/applications/ApplyCopyFields.js';
import type { ApplyCopyResult, ApplyCopyView } from '../../../electron/apply-copy-types.js';

/**
 * #660 in the renderer: what the "Copy for the employer form" group shows for a given verified view,
 * that copying is one clipboard write per click with no further bridge call, and that unavailable
 * documents say so instead of offering stale values.
 */

const VIEW: ApplyCopyView = {
  letters: [{ kind: 'cover_letter', text: 'Dear team,\n\nI would like to apply.', version: 2, artifactHash: 'hash-l' }],
  letterUnavailable: null,
  contact: {
    name: 'Dana Doe',
    email: 'dana@example.test',
    phone: '',
    location: 'Rotterdam',
    links: ['https://example.test/dana', 'https://git.example.test/dana'],
    version: 2,
    artifactHash: 'hash-cv',
  },
  contactUnavailable: null,
};

function install(view: ApplyCopyView): ReturnType<typeof vi.fn> {
  const get = vi.fn(async (): Promise<ApplyCopyResult> => ({ ok: true, view }));
  (window as unknown as { applyCopyFields: unknown }).applyCopyFields = { get };
  return get;
}

afterEach(() => {
  delete (window as unknown as { applyCopyFields?: unknown }).applyCopyFields;
});

describe('ApplyCopyFields', () => {
  it('shows one labelled copy button per value and hides empty fields', async () => {
    install(VIEW);
    render(<ApplyCopyFields attemptId="attempt-1" reloadKey="t1" />);
    expect(await screen.findByRole('button', { name: 'Copy cover letter text' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy name' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy email' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy location' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy phone' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy link 1' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy link 2' })).toBeInTheDocument();
    expect(screen.getByText('dana@example.test')).toBeInTheDocument();
  });

  it('copies exactly the shown value on a click, without another bridge call', async () => {
    const get = install(VIEW);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<ApplyCopyFields attemptId="attempt-1" reloadKey="t1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Copy cover letter text' }));
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith('Dear team,\n\nI would like to apply.');
    expect(await screen.findByRole('status')).toHaveTextContent('Copied');
    fireEvent.click(screen.getByRole('button', { name: 'Copy email' }));
    expect(writeText).toHaveBeenLastCalledWith('dana@example.test');
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('says letter text is unavailable instead of offering anything', async () => {
    install({ ...VIEW, letters: [], letterUnavailable: 'changed' });
    render(<ApplyCopyFields attemptId="attempt-1" reloadKey="t1" />);
    expect(await screen.findByTestId('apply-copy-letter-unavailable')).toHaveTextContent(
      'Letter text is not available to copy. Open the letter to copy it by hand.',
    );
    expect(screen.queryByRole('button', { name: /letter text/ })).not.toBeInTheDocument();
  });

  it('says contact details are unavailable and shows no contact field', async () => {
    install({ ...VIEW, contact: null, contactUnavailable: 'no_draft' });
    render(<ApplyCopyFields attemptId="attempt-1" reloadKey="t1" />);
    expect(await screen.findByTestId('apply-copy-contact-unavailable')).toHaveTextContent('Contact details are not available to copy.');
    expect(screen.queryByRole('button', { name: 'Copy email' })).not.toBeInTheDocument();
  });

  it('renders nothing when no document was staged', async () => {
    install({ letters: [], letterUnavailable: null, contact: null, contactUnavailable: null });
    render(<ApplyCopyFields attemptId="attempt-1" reloadKey="t1" />);
    await waitFor(() => expect(screen.queryByTestId('apply-copy-fields')).not.toBeInTheDocument());
  });
});
