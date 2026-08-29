import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { AtsProvider, CareerSourceDescriptor } from '../../src/domain/models.js';
import type {
  AtsHttpClient,
  AtsHttpRequestOptions,
  AtsHttpResponse,
} from '../../src/ats/http.js';

export async function atsFixture(relativePath: string): Promise<string> {
  return readFile(path.resolve(process.cwd(), 'test/fixtures/ats', relativePath), 'utf8');
}

export function jsonPostFixtureKey(url: string, body: unknown): string {
  return `POST ${url}\n${JSON.stringify(body)}`;
}

export function careerSource(
  provider: AtsProvider,
  boardIdentifier: string | null,
  baseUrl: string,
): CareerSourceDescriptor {
  return {
    id: `${provider}-source`,
    companyId: 'company-1',
    companyName: 'Acme B.V.',
    provider,
    baseUrl,
    boardIdentifier,
  };
}

type RouteValue = string | AtsHttpResponse | (() => string | AtsHttpResponse | Promise<string | AtsHttpResponse>);

export class FixtureHttpClient implements AtsHttpClient {
  public readonly requestedUrls: string[] = [];
  public readonly requestedOptions: (AtsHttpRequestOptions | undefined)[] = [];
  public readonly requestedJsonBodies: unknown[] = [];

  public constructor(private readonly routes: ReadonlyMap<string, RouteValue>) {}

  public async get(url: string, options?: AtsHttpRequestOptions): Promise<AtsHttpResponse> {
    this.requestedUrls.push(url);
    this.requestedOptions.push(options);
    const route = this.routes.get(url);
    if (route === undefined) throw new Error(`Unexpected fixture URL: ${url}`);
    const value = typeof route === 'function' ? await route() : route;
    if (typeof value !== 'string') return value;
    return {
      status: 200,
      finalUrl: url,
      headers: {},
      body: value,
    };
  }

  public async postJson(
    url: string,
    body: unknown,
    options?: AtsHttpRequestOptions,
  ): Promise<AtsHttpResponse> {
    this.requestedUrls.push(url);
    this.requestedOptions.push(options);
    this.requestedJsonBodies.push(body);
    const route = this.routes.get(jsonPostFixtureKey(url, body));
    if (route === undefined) throw new Error(`Unexpected fixture JSON POST: ${url}`);
    const value = typeof route === 'function' ? await route() : route;
    if (typeof value !== 'string') return value;
    return {
      status: 200,
      finalUrl: url,
      headers: { 'content-type': 'application/json' },
      body: value,
    };
  }
}
