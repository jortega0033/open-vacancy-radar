/** Base class for every client error. Use `instanceof AgentDockClientError` to catch all of them. */
export abstract class AgentDockClientError extends Error {}

/** The daemon could not be reached because the connection was refused, DNS resolution failed, the request timed out, or it was aborted. */
export class DaemonUnavailableError extends AgentDockClientError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'DaemonUnavailableError';
  }
}

/** The daemon rejected the request's bearer token (HTTP 401). */
export class UnauthorizedError extends AgentDockClientError {
  constructor(message = 'The daemon rejected this client\'s token.') {
    super(message);
    this.name = 'UnauthorizedError';
  }
}

/**
 * The daemon's protocol version doesn't match what this client was built against. Thrown from
 * the first call any client method makes (see client.ts's compatibility check). It is not something
 * you need to check for manually.
 */
export class ProtocolMismatchError extends AgentDockClientError {
  constructor(
    public readonly clientVersion: number,
    public readonly daemonVersion: number,
  ) {
    super(`This client supports protocol ${clientVersion}, but the daemon reports protocol ${daemonVersion}.`);
    this.name = 'ProtocolMismatchError';
  }
}

/** The daemon rejected the request as malformed (HTTP 400), or an SSE frame failed schema validation. */
export class ValidationError extends AgentDockClientError {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

/** `GET/POST /sessions/:id...` referenced a session id the daemon doesn't know about (HTTP 404). */
export class SessionNotFoundError extends AgentDockClientError {
  constructor(public readonly sessionId: string) {
    super(`Session not found: ${sessionId}.`);
    this.name = 'SessionNotFoundError';
  }
}

/** `GET /providers/:id` referenced a provider id the daemon has no adapter for (HTTP 404), or `POST /sessions` named an unsupported provider (HTTP 400). */
export class ProviderUnavailableError extends AgentDockClientError {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderUnavailableError';
  }
}

/** Any other daemon-declared failure. Preserves the daemon's status code and message. */
export class DaemonError extends AgentDockClientError {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'DaemonError';
  }
}
