import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { mcpJobDetailRequestSchema, mcpProviderIdSchema, mcpSearchRequestSchema } from '../mcp/types.js';
import type { McpConnectionManager } from '../mcp/manager.js';

const providerParamsSchema = z.object({ providerId: mcpProviderIdSchema }).strict();
const credentialBodySchema = z.object({ credential: z.string().min(1).max(16_384) }).strict();
const jobDetailParamsSchema = z.object({
  providerId: mcpProviderIdSchema,
  externalId: mcpJobDetailRequestSchema.shape.externalId,
}).strict();

export function registerMcpRoutes(app: FastifyInstance, manager: McpConnectionManager): void {
  app.get('/mcp/providers', async () => ({ providers: await manager.statuses() }));

  app.get('/mcp/providers/:providerId', async (request, reply) => {
    const params = providerParamsSchema.safeParse(request.params);
    if (!params.success || !manager.providerIds().includes(params.data.providerId)) {
      reply.code(404).send({ error: 'MCP provider is not allowlisted' });
      return;
    }
    reply.send(await manager.status(params.data.providerId));
  });

  app.put('/mcp/providers/:providerId/credential', async (request, reply) => {
    const params = providerParamsSchema.safeParse(request.params);
    const body = credentialBodySchema.safeParse(request.body);
    if (!params.success || !manager.providerIds().includes(params.data.providerId)) {
      reply.code(404).send({ error: 'MCP provider is not allowlisted' });
      return;
    }
    if (!body.success) {
      reply.code(400).send({ error: 'invalid credential' });
      return;
    }
    await manager.setCredential(params.data.providerId, body.data.credential);
    reply.code(204).send();
  });

  app.post('/mcp/search', async (request, reply) => {
    const parsed = mcpSearchRequestSchema.safeParse(request.body);
    if (!parsed.success || !manager.providerIds().includes(parsed.data.providerId)) {
      reply.code(400).send({ error: 'invalid MCP search request' });
      return;
    }
    const controller = new AbortController();
    request.raw.once('aborted', () => controller.abort(new Error('request aborted')));
    reply.send({ results: await manager.search(parsed.data, controller.signal) });
  });

  // `get_job` counterpart to `/mcp/search`: a bounded, allowlisted-providerId + opaque-externalId
  // single-listing lookup, never a caller-suppliable tool name or arguments. A provider whose policy
  // never configured a detail tool fails inside `manager.getJob` (sanitized to a 500 by the shared
  // error handler), never by silently falling back to some other tool.
  app.get('/mcp/providers/:providerId/jobs/:externalId', async (request, reply) => {
    const params = jobDetailParamsSchema.safeParse(request.params);
    if (!params.success || !manager.providerIds().includes(params.data.providerId)) {
      reply.code(404).send({ error: 'MCP provider is not allowlisted' });
      return;
    }
    const controller = new AbortController();
    request.raw.once('aborted', () => controller.abort(new Error('request aborted')));
    reply.send(await manager.getJob(params.data, controller.signal));
  });

  app.delete('/mcp/providers/:providerId', async (request, reply) => {
    const params = providerParamsSchema.safeParse(request.params);
    if (!params.success || !manager.providerIds().includes(params.data.providerId)) {
      reply.code(404).send({ error: 'MCP provider is not allowlisted' });
      return;
    }
    await manager.remove(params.data.providerId);
    reply.code(204).send();
  });
}
