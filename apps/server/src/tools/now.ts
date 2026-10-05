import type { Tool } from './types.js';

export const nowTool: Tool = {
  name: 'now',
  description: 'Read the current UTC time.',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  tier: 'read',
  async run(args) {
    if (Object.keys(args).length) throw new Error('now takes no arguments');
    const ts = Date.now();
    return { ts, iso: new Date(ts).toISOString() };
  },
};
