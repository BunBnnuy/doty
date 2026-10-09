import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: spawnMock }));
import { CodexImageGenerator, deliverImageRequest, parseImageRequest, readGeneratedImage } from './codex-images.js';

const png = Buffer.from('89504e470d0a1a0a01020304', 'hex');
const directories: string[] = [];
async function directory(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'doty-test-image-'));
  directories.push(dir);
  return dir;
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('image requests', () => {
  it('accepts a complete image request and a fenced response', () => {
    expect(parseImageRequest('{"doty_image_request":{"prompt":"a cat","delivery":"dm"}}'))
      .toEqual({ prompt: 'a cat', delivery: 'dm' });
    expect(parseImageRequest('```json\n{"doty_image_request":{"prompt":"a cat","delivery":"channel"}}\n```'))
      .toEqual({ prompt: 'a cat', delivery: 'channel' });
  });
  it('rejects prose, empty prompts, arbitrary recipients and oversized prompts', () => {
    for (const answer of ['hello', 'null', '{"doty_image_request":null}',
      '{"doty_image_request":{"prompt":"","delivery":"dm"}}',
      '{"doty_image_request":{"prompt":"cat","delivery":"12345"}}',
      JSON.stringify({ doty_image_request: { prompt: 'x'.repeat(16001), delivery: 'dm' } })]) {
      expect(parseImageRequest(answer)).toBeUndefined();
    }
  });
});

describe('generated files', () => {
  it('returns only a PNG from the job workspace', async () => {
    const dir = await directory();
    await writeFile(join(dir, 'image.png'), png);
    const file = await readGeneratedImage(dir);
    expect(file.filename).toBe('doty-image.png');
    expect(file.data).toEqual(png);
  });
  it('rejects missing, non-image, oversized and symbolic-link files', async () => {
    const dir = await directory();
    await expect(readGeneratedImage(dir)).rejects.toThrow();
    await writeFile(join(dir, 'image.png'), 'not an image');
    await expect(readGeneratedImage(dir)).rejects.toThrow('PNG');
    await writeFile(join(dir, 'image.png'), Buffer.alloc(10 * 1024 * 1024 + 1));
    await expect(readGeneratedImage(dir)).rejects.toThrow('10 MiB');
    await rm(join(dir, 'image.png'));
    await writeFile(join(dir, 'outside.png'), png);
    try { await symlink(join(dir, 'outside.png'), join(dir, 'image.png')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EPERM') return; throw error; }
    await expect(readGeneratedImage(dir)).rejects.toThrow('invalid');
  });
});

describe('image delivery', () => {
  const file = { filename: 'image.png', mime: 'image/png', data: png };
  const context = { userId: 'requester', isDm: false, channelId: 'guild-channel' };
  it('returns attachments for the current server channel or DM', async () => {
    const generator = { generate: vi.fn().mockResolvedValue(file) };
    const discord = { send: vi.fn(), dmChannel: vi.fn() };
    const request = { prompt: 'cat', delivery: 'channel' as const };
    expect(await deliverImageRequest(request, context, [], generator, discord)).toMatchObject({ files: [file] });
    expect(await deliverImageRequest({ ...request, delivery: 'dm' }, { ...context, isDm: true }, [], generator, discord))
      .toMatchObject({ files: [file] });
    expect(discord.dmChannel).not.toHaveBeenCalled();
    expect(discord.send).not.toHaveBeenCalled();
  });
  it('opens only the requesting user DM and confirms after successful upload', async () => {
    const generator = { generate: vi.fn().mockResolvedValue(file) };
    const discord = { send: vi.fn().mockResolvedValue(undefined), dmChannel: vi.fn().mockResolvedValue('private') };
    const request = { prompt: 'cat', delivery: 'dm' as const };
    expect(await deliverImageRequest(request, context, [], generator, discord)).toContain('DM');
    expect(discord.dmChannel).toHaveBeenCalledWith('requester');
    expect(discord.send).toHaveBeenCalledWith('private', expect.objectContaining({ files: [file] }));
    discord.send.mockRejectedValue(new Error('upload failed'));
    await expect(deliverImageRequest(request, context, [], generator, discord)).rejects.toThrow('upload failed');
  });
  it('does not generate an image if the DM cannot be opened', async () => {
    const generator = { generate: vi.fn() };
    const discord = { send: vi.fn(), dmChannel: vi.fn().mockResolvedValue(undefined) };
    expect(await deliverImageRequest({ prompt: 'cat', delivery: 'dm' }, context, [], generator, discord)).toContain('permisos');
    expect(generator.generate).not.toHaveBeenCalled();
  });
});

describe('Codex process', () => {
  it('uses stdin, attaches references, strips server secrets and cleans up', async () => {
    vi.stubEnv('DISCORD_BOT_TOKEN', 'test-only-secret');
    vi.stubEnv('OPENAI_API_KEY', 'test-only-secret');
    const codexHome = await directory();
    vi.stubEnv('CODEX_HOME', codexHome);
    const threadId = '01a1217d-9b36-75e2-a3e4-daac99bc16e5';
    const imageDir = join(codexHome, 'generated_images', threadId);
    await mkdir(imageDir, { recursive: true });
    let jobDir = '';
    let task = '';
    spawnMock.mockImplementation((_binary, args, options) => {
      expect(options.shell).toBe(false);
      expect(options.env.DISCORD_BOT_TOKEN).toBeUndefined();
      expect(options.env.OPENAI_API_KEY).toBeUndefined();
      expect(args).toContain('image_generation');
      expect(args).not.toContain('--approve-for-me');
      jobDir = args[args.indexOf('--cd') + 1];
      const child = new EventEmitter();
      const stdout = new EventEmitter();
      const stdin = new EventEmitter() as EventEmitter & { end: (text: string) => void };
      stdin.end = (text) => {
        task = text;
        stdout.emit('data', Buffer.from(JSON.stringify({ type: 'thread.started', thread_id: threadId }) + '\n'));
        void Promise.all([
          writeFile(join(imageDir, 'image.png'), png),
          writeFile(join(jobDir, 'result.json'), JSON.stringify({ image_path: join(imageDir, 'image.png') })),
        ]).then(() => child.emit('close', 0));
      };
      return Object.assign(child, { stdin, stdout });
    });
    try {
      const file = await new CodexImageGenerator().generate('cat; $(not a shell command)',
        [{ mime: 'image/png', dataUrl: `data:image/png;base64,${png.toString('base64')}` }]);
      expect(file.data).toEqual(png);
      expect(task).toContain('cat; $(not a shell command)');
      expect(spawnMock.mock.calls.at(-1)?.[1]).toContain('--image');
      await expect(readFile(join(jobDir, 'reference-0.png'))).rejects.toThrow();
    } finally { vi.unstubAllEnvs(); }
  });
  it('rejects concurrent jobs and releases the slot after a CLI failure', async () => {
    const child = new EventEmitter();
    const stdin = Object.assign(new EventEmitter(), { end: vi.fn() });
    spawnMock.mockReturnValue(Object.assign(child, { stdin, stdout: new EventEmitter() }));
    const generator = new CodexImageGenerator();
    const first = generator.generate('cat');
    await expect(generator.generate('dog')).rejects.toThrow('busy');
    // Wait until the asynchronous workspace setup has started the process.
    await vi.waitFor(() => expect(stdin.end).toHaveBeenCalled());
    child.emit('close', 1);
    await expect(first).rejects.toThrow('failed');
    const second = generator.generate('dog');
    await vi.waitFor(() => expect(stdin.end).toHaveBeenCalledTimes(2));
    child.emit('close', 1);
    await expect(second).rejects.toThrow('failed');
  });
});
