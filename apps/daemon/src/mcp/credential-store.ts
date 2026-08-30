import { Entry } from '@napi-rs/keyring';
import type { McpCredentialStore, McpProviderId } from './types.js';

const SERVICE = 'open-vacancy-radar.mcp';

export class OsMcpCredentialStore implements McpCredentialStore {
  async get(providerId: McpProviderId): Promise<string | null> {
    return new Entry(SERVICE, providerId).getPassword();
  }

  async set(providerId: McpProviderId, value: string): Promise<void> {
    if (!value.trim()) throw new Error('credential must not be empty');
    new Entry(SERVICE, providerId).setPassword(value);
  }

  async delete(providerId: McpProviderId): Promise<void> {
    new Entry(SERVICE, providerId).deletePassword();
  }
}
