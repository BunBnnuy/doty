/**
 * Discord voice playback.
 *
 * Connects to a voice channel with `@discordjs/voice` through a small adapter
 * over Doty's raw gateway, then streams YouTube audio via `yt-dlp` piped into
 * `ffmpeg` (s16le 48 kHz stereo, which the voice library encodes to Opus).
 *
 * Commands are parsed from the message text (`play`/`skip`/`stop`/`pause`/
 * `resume`/`queue`, English + Spanish aliases).
 */

import { spawn, type ChildProcess } from 'node:child_process';
import type { Readable } from 'node:stream';
import {
  AudioPlayerStatus,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
  type AudioPlayer,
  type DiscordGatewayAdapterCreator,
  type DiscordGatewayAdapterLibraryMethods,
  type VoiceConnection,
} from '@discordjs/voice';

export type VoiceCommandName = 'play' | 'skip' | 'stop' | 'pause' | 'resume' | 'queue';

export interface VoiceCommand {
  cmd: VoiceCommandName;
  arg?: string;
}

const COMMAND_ALIASES: Record<string, VoiceCommandName> = {
  play: 'play', p: 'play', reproduce: 'play', pon: 'play', tocar: 'play',
  skip: 'skip', next: 'skip', siguiente: 'skip', salta: 'skip',
  stop: 'stop', leave: 'stop', salir: 'stop', para: 'stop', parar: 'stop', detente: 'stop', detener: 'stop',
  pause: 'pause', pausa: 'pause',
  resume: 'resume', continuar: 'resume', continua: 'resume', reanuda: 'resume',
  queue: 'queue', cola: 'queue', lista: 'queue',
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Parse a voice command from a message body, stripping leading trigger words. */
export function parseVoiceCommand(text: string, triggerWords: readonly string[] = ['doty', 'bot']): VoiceCommand | null {
  let cleaned = text.trim();
  let changed = true;
  while (changed) {
    changed = false;
    for (const word of triggerWords) {
      if (!word) continue;
      const stripped = cleaned.replace(new RegExp(`^${escapeRegExp(word)}\\b[:,]?\\s*`, 'i'), '');
      if (stripped !== cleaned) {
        cleaned = stripped;
        changed = true;
      }
    }
  }
  const match = /^(\S+)(?:\s+([\s\S]+))?$/.exec(cleaned.trim());
  if (!match) return null;
  const cmd = COMMAND_ALIASES[match[1]!.toLowerCase()];
  if (!cmd) return null;
  const arg = match[2]?.trim();
  return { cmd, ...(arg ? { arg } : {}) };
}

/** yt-dlp -> ffmpeg -> raw PCM stream for `@discordjs/voice`. */
export function createTrackStream(query: string, onError?: (message: string) => void): Readable {
  const target = /^https?:\/\//i.test(query) ? query : `ytsearch1:${query}`;
  const ytdlp = spawn('yt-dlp', ['-f', 'bestaudio/best', '--no-playlist', '--no-warnings', '-o', '-', target], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const ffmpeg = spawn(
    'ffmpeg',
    ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-vn', '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1'],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
  ytdlp.stdout!.pipe(ffmpeg.stdin!);
  const report = (label: string, child: ChildProcess): void => {
    child.stderr?.on('data', (chunk: Buffer) => {
      const line = chunk.toString().split('\n').find((item) => item.trim());
      if (line) onError?.(`${label}: ${line.trim().slice(0, 160)}`);
    });
    child.on('error', (error) => onError?.(`${label}: ${error.message}`));
  };
  report('yt-dlp', ytdlp);
  report('ffmpeg', ffmpeg);
  return ffmpeg.stdout;
}

interface GuildPlayer {
  connection: VoiceConnection;
  player: AudioPlayer;
  queue: string[];
  current?: string;
  channelId: string;
}

export interface VoiceManagerOptions {
  log?: (message: string) => void;
}

export class VoiceManager {
  readonly #guilds = new Map<string, GuildPlayer>();
  readonly #adapters = new Map<string, DiscordGatewayAdapterLibraryMethods>();
  readonly #voiceChannels = new Map<string, string | null>();
  readonly #log: (message: string) => void;
  #send: ((payload: unknown) => boolean) | undefined;

  constructor(options: VoiceManagerOptions = {}) {
    this.#log = options.log ?? (() => {});
  }

  /** The raw gateway sender (installed once the socket is open). */
  setGatewaySender(send: (payload: unknown) => boolean): void {
    this.#send = send;
  }

  onVoiceStateUpdate(data: unknown): void {
    const state = data as { guild_id?: string; user_id?: string; channel_id?: string | null };
    if (typeof state.guild_id === 'string' && typeof state.user_id === 'string') {
      this.#voiceChannels.set(`${state.guild_id}:${state.user_id}`, state.channel_id ?? null);
    }
    if (typeof state.guild_id === 'string') {
      this.#adapters.get(state.guild_id)?.onVoiceStateUpdate(
        data as Parameters<DiscordGatewayAdapterLibraryMethods['onVoiceStateUpdate']>[0],
      );
    }
  }

  onVoiceServerUpdate(data: unknown): void {
    const server = data as { guild_id?: string };
    if (typeof server.guild_id === 'string') {
      this.#adapters.get(server.guild_id)?.onVoiceServerUpdate(
        data as Parameters<DiscordGatewayAdapterLibraryMethods['onVoiceServerUpdate']>[0],
      );
    }
  }

  /** The voice channel a user is currently in, if known. */
  channelOf(guildId: string, userId: string): string | null {
    return this.#voiceChannels.get(`${guildId}:${userId}`) ?? null;
  }

  #adapterCreator(guildId: string): DiscordGatewayAdapterCreator {
    return (methods) => {
      this.#adapters.set(guildId, methods);
      return {
        sendPayload: (payload) => (this.#send ? this.#send(payload) : false),
        destroy: () => {
          if (this.#adapters.get(guildId) === methods) this.#adapters.delete(guildId);
        },
      };
    };
  }

  async #ensure(guildId: string, channelId: string): Promise<GuildPlayer> {
    const existing = this.#guilds.get(guildId);
    if (existing
      && existing.channelId === channelId
      && existing.connection.state.status !== VoiceConnectionStatus.Destroyed) {
      return existing;
    }
    if (existing) {
      try { existing.connection.destroy(); } catch { /* ignore */ }
    }
    const connection = joinVoiceChannel({
      channelId,
      guildId,
      adapterCreator: this.#adapterCreator(guildId),
      selfDeaf: true,
      selfMute: false,
    });
    const player = createAudioPlayer();
    connection.subscribe(player);
    const guild: GuildPlayer = { connection, player, queue: [], channelId };
    this.#guilds.set(guildId, guild);
    player.on(AudioPlayerStatus.Idle, () => void this.#next(guildId));
    player.on('error', (error) => {
      this.#log(`voice: player error (${error.message.slice(0, 120)})`);
      void this.#next(guildId);
    });
    connection.on(VoiceConnectionStatus.Disconnected, () => {
      this.#log('voice: disconnected');
    });
    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
    } catch {
      this.#log('voice: connection did not become ready');
    }
    return guild;
  }

  #start(guild: GuildPlayer, query: string): void {
    guild.current = query;
    const stream = createTrackStream(query, (message) => this.#log(`voice: ${message}`));
    guild.player.play(createAudioResource(stream, { inputType: StreamType.Raw }));
  }

  async #next(guildId: string): Promise<void> {
    const guild = this.#guilds.get(guildId);
    if (!guild) return;
    const next = guild.queue.shift();
    if (!next) {
      guild.current = undefined;
      return;
    }
    this.#start(guild, next);
  }

  async play(guildId: string, channelId: string, query: string): Promise<string> {
    if (!query.trim()) return 'Dime qué reproduzco: `doty play <url o búsqueda>`.';
    const guild = await this.#ensure(guildId, channelId);
    if (guild.current) {
      guild.queue.push(query);
      return `Encolado (posición ${guild.queue.length}): ${query}`;
    }
    this.#start(guild, query);
    return `Reproduciendo: ${query}`;
  }

  skip(guildId: string): string {
    const guild = this.#guilds.get(guildId);
    if (!guild || !guild.current) return 'No hay nada reproduciéndose.';
    guild.player.stop();
    return 'Saltando…';
  }

  pause(guildId: string): string {
    const guild = this.#guilds.get(guildId);
    if (!guild || !guild.current) return 'No hay nada reproduciéndose.';
    guild.player.pause();
    return 'Pausado.';
  }

  resume(guildId: string): string {
    const guild = this.#guilds.get(guildId);
    if (!guild || !guild.current) return 'No hay nada reproduciéndose.';
    guild.player.unpause();
    return 'Reanudando.';
  }

  queue(guildId: string): string {
    const guild = this.#guilds.get(guildId);
    if (!guild || (!guild.current && guild.queue.length === 0)) return 'La cola está vacía.';
    const lines: string[] = [];
    if (guild.current) lines.push(`▶️ ${guild.current}`);
    guild.queue.forEach((item, index) => lines.push(`${index + 1}. ${item}`));
    return lines.join('\n');
  }

  stop(guildId: string): string {
    const guild = this.#guilds.get(guildId);
    if (!guild) return 'No estoy en un canal de voz.';
    guild.queue.length = 0;
    guild.current = undefined;
    try { guild.player.stop(true); } catch { /* ignore */ }
    try { guild.connection.destroy(); } catch { /* ignore */ }
    this.#guilds.delete(guildId);
    return 'Saliendo del canal de voz.';
  }

  destroy(): void {
    for (const guild of this.#guilds.values()) {
      try { guild.connection.destroy(); } catch { /* ignore */ }
    }
    this.#guilds.clear();
  }
}
