/**
 * Natural-language command classifier.
 *
 * Decides whether a message addressed to Doty is a voice/music command or plain
 * conversation, using an OpenAI-compatible chat model. Used as a fallback after
 * the fast keyword parser so most commands need no model call.
 */

import type { VoiceCommand, VoiceCommandName } from './voice.js';

export interface ClassifierConfig {
  baseUrl: string;
  apiKey?: string;
  model: string;
  /** Sent as x-opencode-session (the OpenCode Go gateway requires it). */
  sessionId?: string;
  userAgent?: string;
  timeoutMs?: number;
}

const COMMAND_NAMES: readonly VoiceCommandName[] = ['play', 'skip', 'stop', 'pause', 'resume', 'queue', 'join', 'say'];

const SYSTEM_PROMPT = [
  'You route a single Discord message addressed to a music bot named "Doty".',
  'Decide if the message is a voice/music COMMAND or just CONVERSATION.',
  'Commands (pick exactly one):',
  '- play: start or queue music. arg = song / artist / url / query.',
  '  examples: "pon bachata" -> play bachata; "reproduce lofi" -> play lofi; "quiero escuchar X" -> play X.',
  '- skip: next track. "siguiente", "salta", "cambia de cancion".',
  '- stop: leave the voice channel. "salite", "salte", "salir", "andate", "desconectate", "stop", "leave".',
  '- pause: "pausa", "pausala".',
  '- resume: "continua", "reanuda".',
  '- queue: show the queue. "cola", "que hay", "lista".',
  '- join: join the voice channel. "entra", "unete", "ven al voice".',
  '- say: speak text aloud. arg = the text. "deci X", "di X", "habla".',
  'If it is not a command (a question, chat, greeting, etc.), use "none".',
  'Reply with ONLY minified JSON, no prose and no code fences:',
  '{"command":"<name>","arg":"<arg>"} or {"command":"none"}.',
].join('\n');

/** Extract and validate the JSON intent from a model reply. */
export function parseIntentReply(content: string): VoiceCommand | null {
  const match = content.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  const command = record.command;
  if (typeof command !== 'string' || !(COMMAND_NAMES as readonly string[]).includes(command)) return null;
  const arg = typeof record.arg === 'string' ? record.arg.trim() : '';
  return { cmd: command as VoiceCommandName, ...(arg ? { arg } : {}) };
}

/** Ask the model to classify the message. Returns null for conversation / failure. */
export async function classifyVoiceIntent(
  text: string,
  config: ClassifierConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<VoiceCommand | null> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json',
    'User-Agent': config.userAgent ?? 'doty/0.1',
    'x-opencode-session': config.sessionId ?? 'doty-commands',
  };
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs ?? 15_000);
  try {
    const response = await fetchImpl(`${config.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        model: config.model,
        stream: false,
        temperature: 0,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: text },
        ],
      }),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { choices?: Array<{ message?: { content?: unknown } }> };
    const content = body.choices?.[0]?.message?.content;
    return typeof content === 'string' ? parseIntentReply(content) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// Jev (TypeSafe) — typed decision API: state + questions -> typed answers.
// ---------------------------------------------------------------------------

export interface JevConfig {
  /** e.g. https://jevtypesafeai.com/api/v1/decide */
  baseUrl: string;
  apiKey: string;
  /** Pin a version like `jev-1.13.0`; omit for the hosted default. */
  model?: string;
  timeoutMs?: number;
}

const JEV_CRITERIA: Record<string, string> = {
  play: 'start or queue music; the song/artist/url is what should be played',
  skip: 'go to the next track',
  stop: 'leave the voice channel / disconnect',
  pause: 'pause the music',
  resume: 'resume the music',
  queue: 'show what is currently queued',
  join: 'join the voice channel',
  say: 'speak the given text out loud',
  none: 'not a command; conversation, a question, or a greeting',
};

/** Read `answers.command.choice` from a Jev response. */
export function parseJevAnswer(body: unknown): VoiceCommand | null {
  if (typeof body !== 'object' || body === null) return null;
  const answers = (body as Record<string, unknown>).answers;
  if (typeof answers !== 'object' || answers === null) return null;
  const command = (answers as Record<string, unknown>).command;
  if (typeof command !== 'object' || command === null) return null;
  const choice = (command as Record<string, unknown>).choice;
  if (typeof choice !== 'string' || !(COMMAND_NAMES as readonly string[]).includes(choice)) return null;
  return { cmd: choice as VoiceCommandName };
}

/** Classify a message with the Jev typed-decision API. */
export async function classifyVoiceIntentJev(
  text: string,
  config: JevConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<VoiceCommand | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs ?? 15_000);
  try {
    const response = await fetchImpl(config.baseUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        ...(config.model ? { model: config.model } : {}),
        state: text,
        questions: {
          command: {
            type: 'choice',
            instructions: 'Which music/voice command does the message ask for, if any?',
            criteria: JEV_CRITERIA,
          },
        },
      }),
    });
    if (!response.ok) return null;
    return parseJevAnswer(await response.json());
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
