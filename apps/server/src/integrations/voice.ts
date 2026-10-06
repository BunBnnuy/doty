/**
 * Discord voice: music + text-to-speech.
 *
 * Connects to a voice channel with `@discordjs/voice` through a small adapter
 * over Doty's raw gateway. Music streams YouTube audio via `yt-dlp` piped into
 * `ffmpeg`; speech is synthesized locally with `piper` and played through a
 * second audio player (pausing/resuming music).
 *
 * Commands are parsed from the message text (`play`/`skip`/`stop`/`pause`/
 * `resume`/`queue`/`join`/`say`, English + Spanish aliases).
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
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

export type VoiceCommandName = 'play' | 'skip' | 'stop' | 'pause' | 'resume' | 'queue' | 'join' | 'say';

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
  join: 'join', entra: 'join', unete: 'join', únete: 'join', entrar: 'join',
  say: 'say', di: 'say', decir: 'say', habla: 'say',
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

function logChild(label: string, child: ChildProcess, onError?: (message: string) => void): void {
  child.stderr?.on('data', (chunk: Buffer) => {
    const line = chunk.toString().split('\n').find((item) => item.trim());
    if (line) onError?.(`${label}: ${line.trim().slice(0, 160)}`);
  });
  child.on('error', (error) => onError?.(`${label}: ${error.message}`));
}

/** yt-dlp -> ffmpeg -> raw PCM stream for music. */
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
  logChild('yt-dlp', ytdlp, onError);
  logChild('ffmpeg', ffmpeg, onError);
  return ffmpeg.stdout!;
}

/** ffmpeg -> raw PCM stream from a local WAV file (piper output). */
export function createWavStream(wavPath: string, onError?: (message: string) => void): Readable {
  const ffmpeg = spawn(
    'ffmpeg',
    ['-hide_banner', '-loglevel', 'error', '-i', wavPath, '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1'],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  logChild('ffmpeg(tts)', ffmpeg, onError);
  return ffmpeg.stdout!;
}

/** Synthesize text to a temp WAV with piper. */
export function synthesizeSpeech(
  text: string,
  piperBin: string,
  piperVoice: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const output = joinPath(tmpdir(), `doty-tts-${randomUUID()}.wav`);
    const child = spawn(piperBin, ['--model', piperVoice, '--output_file', output], {
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(output);
      else reject(new Error(`piper exited ${code}: ${stderr.slice(-120).trim()}`));
    });
    child.stdin?.end(text);
  });
}

interface GuildPlayer {
  connection: VoiceConnection;
  player: AudioPlayer;
  speech: AudioPlayer;
  queue: string[];
  current?: string;
  channelId: string;
  speechTemp?: string;
  musicPausedForSpeech: boolean;
}

export interface VoiceManagerOptions {
  log?: (message: string) => void;
  piperBin?: string;
  piperVoice?: string;
  /** Max characters spoken per reply. */
  maxSpeechChars?: number;
}

const DEFAULT_PIPER_BIN = '/opt/vtamigo/backend/piper/piper/piper';
const DEFAULT_PIPER_VOICE = '/opt/vtamigo/backend/piper/voices/es_MX-alan-medium.onnx';

export class VoiceManager {
  readonly #guilds = new Map<string, GuildPlayer>();
  readonly #adapters = new Map<string, DiscordGatewayAdapterLibraryMethods>();
  readonly #voiceChannels = new Map<string, string | null>();
  readonly #log: (message: string) => void;
  readonly #piperBin: string;
  readonly #piperVoice: string;
  readonly #maxSpeechChars: number;
  #send: ((payload: unknown) => boolean) | undefined;

  constructor(options: VoiceManagerOptions = {}) {
    this.#log = options.log ?? (() => {});
    this.#piperBin = options.piperBin ?? DEFAULT_PIPER_BIN;
    this.#piperVoice = options.piperVoice ?? DEFAULT_PIPER_VOICE;
    this.#maxSpeechChars = options.maxSpeechChars ?? 400;
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

  /** Whether Doty is currently connected to a voice channel in this guild. */
  connected(guildId: string): boolean {
    return this.#guilds.has(guildId);
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
    const speech = createAudioPlayer();
    const guild: GuildPlayer = { connection, player, speech, queue: [], channelId, musicPausedForSpeech: false };
    this.#guilds.set(guildId, guild);
    connection.subscribe(player);
    player.on(AudioPlayerStatus.Idle, () => void this.#next(guildId));
    player.on('error', (error) => {
      this.#log(`voice: player error (${error.message.slice(0, 120)})`);
      void this.#next(guildId);
    });
    speech.on(AudioPlayerStatus.Idle, () => {
      // Restore music after a spoken line.
      try { connection.subscribe(player); } catch { /* ignore */ }
      if (guild.musicPausedForSpeech) {
        guild.musicPausedForSpeech = false;
        try { player.unpause(); } catch { /* ignore */ }
      }
      const temp = guild.speechTemp;
      guild.speechTemp = undefined;
      if (temp) void unlink(temp).catch(() => undefined);
    });
    speech.on('error', (error) => this.#log(`voice: speech error (${error.message.slice(0, 120)})`));
    connection.on(VoiceConnectionStatus.Disconnected, () => this.#log('voice: disconnected'));
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

  /** Join the given voice channel without playing anything. */
  async join(guildId: string, channelId: string): Promise<string> {
    await this.#ensure(guildId, channelId);
    return 'Me uní al canal de voz. 🎧';
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

  /** Speak `text` in the guild's voice channel (no-op if not connected). */
  async speak(guildId: string, text: string): Promise<void> {
    const guild = this.#guilds.get(guildId);
    const trimmed = text.replace(/[*_`#>]/g, '').replace(/\s+/g, ' ').trim().slice(0, this.#maxSpeechChars);
    if (!guild || !trimmed) return;
    let wav: string;
    try {
      wav = await synthesizeSpeech(trimmed, this.#piperBin, this.#piperVoice);
    } catch (error) {
      this.#log(`voice: tts failed (${error instanceof Error ? error.message.slice(0, 120) : 'unknown'})`);
      return;
    }
    if (!this.#guilds.has(guildId)) {
      void unlink(wav).catch(() => undefined);
      return;
    }
    if (guild.musicPausedForSpeech) {
      // Already speaking; just replace the audio.
      guild.speech.stop();
    } else if (guild.player.state.status === AudioPlayerStatus.Playing) {
      guild.musicPausedForSpeech = true;
      try { guild.player.pause(); } catch { /* ignore */ }
    }
    const previous = guild.speechTemp;
    guild.speechTemp = wav;
    if (previous) void unlink(previous).catch(() => undefined);
    try { guild.connection.subscribe(guild.speech); } catch { /* ignore */ }
    guild.speech.play(createAudioResource(createWavStream(wav, (m) => this.#log(`voice: ${m}`)), {
      inputType: StreamType.Raw,
    }));
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
    try { guild.speech.stop(true); } catch { /* ignore */ }
    try { guild.connection.destroy(); } catch { /* ignore */ }
    if (guild.speechTemp) void unlink(guild.speechTemp).catch(() => undefined);
    this.#guilds.delete(guildId);
    return 'Saliendo del canal de voz.';
  }

  destroy(): void {
    for (const guild of this.#guilds.values()) {
      try { guild.connection.destroy(); } catch { /* ignore */ }
      if (guild.speechTemp) void unlink(guild.speechTemp).catch(() => undefined);
    }
    this.#guilds.clear();
  }
}
