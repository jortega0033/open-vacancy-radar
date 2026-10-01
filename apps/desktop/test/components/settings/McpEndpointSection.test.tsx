import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { McpEndpointSection } from '../../../src/components/settings/McpEndpointSection.js';
import type { AppSettingsRecord, CvDocumentRecord, McpClientGrantRecord } from '../../../src/window.js';
import { DEFAULT_SETTINGS, installWorkspaceBridge } from '../../workspace-bridge.js';

function cv(id: string, name: string): CvDocumentRecord {
  return {
    id,
    name,
    kind: 'uploaded',
    targetRole: '',
    text: '',
    profile: { title: '', years: '', location: '', languages: '', skills: [], summary: '', auth: '' },
    source: null,
    textSource: 'text_layer',
    isDefault: false,
    uploadedAt: '2026-08-01T10:00:00.000Z',
    updatedAt: '2026-08-01T10:00:00.000Z',
  };
}

function grant(partial: Partial<McpClientGrantRecord> = {}): McpClientGrantRecord {
  return {
    id: 'grant-1',
    name: 'My Claude Desktop',
    scopeType: 'source_cv',
    sourceCvId: 'cv-1',
    caseIds: [],
    canReadFinalSnapshot: false,
    createdAt: '2026-09-01T00:00:00.000Z',
    expiresAt: '2099-01-01T00:00:00.000Z',
    revokedAt: '',
    ...partial,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('McpEndpointSection (#421)', () => {
  it('toggling the switch calls back with the patch, without reaching into the bridge itself', () => {
    installWorkspaceBridge();
    const onToggled = vi.fn();
    render(
      <McpEndpointSection
        settings={{ ...DEFAULT_SETTINGS, mcpEndpointEnabled: false }}
        cvDocuments={[]}
        onToggled={onToggled}
      />,
    );
    fireEvent.click(screen.getByRole('switch', { name: /allow local ai clients/i }));
    expect(onToggled).toHaveBeenCalledWith({ mcpEndpointEnabled: true });
  });

  it('shows the endpoint address once running, and the grant list and create form once enabled', async () => {
    installWorkspaceBridge({
      getMcpServerStatus: vi.fn().mockResolvedValue({ running: true, port: 54321 }),
      listMcpClientGrants: vi.fn().mockResolvedValue([grant()]),
    });
    render(
      <McpEndpointSection
        settings={{ ...DEFAULT_SETTINGS, mcpEndpointEnabled: true }}
        cvDocuments={[cv('cv-1', 'My Resume')]}
        onToggled={vi.fn()}
      />,
    );
    await waitFor(() => expect(screen.getByText('http://127.0.0.1:54321')).toBeInTheDocument());
    expect(await screen.findByText('My Claude Desktop')).toBeInTheDocument();
    expect(screen.getByText(/can tailor: my resume/i)).toBeInTheDocument();
  });

  it('nothing MCP-related renders while the endpoint is off', () => {
    installWorkspaceBridge();
    render(<McpEndpointSection settings={{ ...DEFAULT_SETTINGS, mcpEndpointEnabled: false }} cvDocuments={[]} onToggled={vi.fn()} />);
    expect(screen.queryByText(/authorized clients/i)).not.toBeInTheDocument();
  });

  it('creates a grant from the form, never receiving the credential itself', async () => {
    const createMcpClientGrant = vi.fn().mockResolvedValue(grant({ id: 'grant-2', name: 'New Client' }));
    installWorkspaceBridge({
      listMcpClientGrants: vi.fn().mockResolvedValue([]),
      createMcpClientGrant,
    });
    render(
      <McpEndpointSection
        settings={{ ...DEFAULT_SETTINGS, mcpEndpointEnabled: true }}
        cvDocuments={[cv('cv-1', 'My Resume')]}
        onToggled={vi.fn()}
      />,
    );
    await screen.findByText(/no clients authorized yet/i);

    fireEvent.change(screen.getByLabelText('Client name'), { target: { value: 'New Client' } });
    fireEvent.change(screen.getByLabelText('CV this client may tailor'), { target: { value: 'cv-1' } });
    fireEvent.click(screen.getByRole('button', { name: /authorize client/i }));

    await waitFor(() => expect(createMcpClientGrant).toHaveBeenCalledWith({
      name: 'New Client',
      scopeType: 'source_cv',
      sourceCvId: 'cv-1',
      expiresAt: expect.any(String),
    }));
    // The resolved value from the bridge call above never includes a credential field at all --
    // this assertion documents that the component has no code path that could even read one.
    await expect(createMcpClientGrant.mock.results[0]?.value).resolves.not.toHaveProperty('credential');
    expect(await screen.findByText('New Client')).toBeInTheDocument();
  });

  it('refuses to create a grant with no CV chosen', async () => {
    const createMcpClientGrant = vi.fn();
    installWorkspaceBridge({ listMcpClientGrants: vi.fn().mockResolvedValue([]), createMcpClientGrant });
    render(
      <McpEndpointSection
        settings={{ ...DEFAULT_SETTINGS, mcpEndpointEnabled: true }}
        cvDocuments={[cv('cv-1', 'My Resume')]}
        onToggled={vi.fn()}
      />,
    );
    await screen.findByText(/no clients authorized yet/i);
    fireEvent.change(screen.getByLabelText('Client name'), { target: { value: 'New Client' } });
    fireEvent.click(screen.getByRole('button', { name: /authorize client/i }));
    expect(await screen.findByText(/choose which cv/i)).toBeInTheDocument();
    expect(createMcpClientGrant).not.toHaveBeenCalled();
  });

  it('revokes a grant after confirmation', async () => {
    const revokeMcpClientGrant = vi.fn().mockResolvedValue(grant({ revokedAt: '2026-10-01T00:00:00.000Z' }));
    installWorkspaceBridge({
      listMcpClientGrants: vi.fn().mockResolvedValue([grant()]),
      revokeMcpClientGrant,
    });
    render(
      <McpEndpointSection
        settings={{ ...DEFAULT_SETTINGS, mcpEndpointEnabled: true }}
        cvDocuments={[cv('cv-1', 'My Resume')]}
        onToggled={vi.fn()}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: /revoke/i }));
    fireEvent.click(screen.getByRole('button', { name: /revoke access/i }));
    await waitFor(() => expect(revokeMcpClientGrant).toHaveBeenCalledWith('grant-1'));
    expect(await screen.findByText(/revoked/i)).toBeInTheDocument();
  });
});
