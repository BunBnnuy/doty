import { describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';

describe('landing page', () => {
  it('serves the landing page at the root', async () => {
    const { app } = buildApp();
    const response = await app.inject({ method: 'GET', url: '/' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.body).toContain('Doty');
    expect(response.body).toContain('always-on');
    await app.close();
  });

  it('does not shadow the API routes', async () => {
    const { app } = buildApp();
    const health = await app.inject({ method: 'GET', url: '/health' });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ status: 'ok' });
    const missing = await app.inject({ method: 'GET', url: '/nope' });
    expect(missing.statusCode).toBe(404);
    await app.close();
  });
});
