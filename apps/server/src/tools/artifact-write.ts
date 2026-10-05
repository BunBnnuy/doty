import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Tool } from './types.js';

/** Lazily allocate a private temporary directory; never accept a model-supplied path. */
export function createArtifactWriteTool(tempRoot: string = tmpdir()): Tool {
  let directory: Promise<string> | undefined;
  return {
    name: 'artifact_write',
    description: 'Write a new UTF-8 artifact in the server temporary artifacts directory. Requires approval.',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string' }, content: { type: 'string', maxLength: 1_000_000 } },
      required: ['name', 'content'],
      additionalProperties: false,
    },
    tier: 'side-effecting',
    async run(args) {
      if (Object.keys(args).some((key) => key !== 'name' && key !== 'content') ||
          typeof args.name !== 'string' || typeof args.content !== 'string') {
        throw new Error('artifact_write requires name and content strings');
      }
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(args.name) ||
          /[.]$/.test(args.name) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(args.name)) {
        throw new Error('Artifact name must be a safe single filename');
      }
      const bytes = Buffer.byteLength(args.content, 'utf8');
      if (bytes > 1_000_000) throw new Error('Artifact content is too large');
      directory ??= mkdir(tempRoot, { recursive: true }).then(() => mkdtemp(join(tempRoot, 'doty-artifacts-')));
      const path = join(await directory, args.name);
      // No overwrites or symlink following: artifacts are immutable new files.
      await writeFile(path, args.content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      return { name: args.name, path, bytes };
    },
  };
}
