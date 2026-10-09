import { classifyDiscordIntentJev, classifyVoiceIntent, type ClassifierConfig, type DiscordIntent, type JevConfig } from './command-classifier.js';
import { parseVoiceCommand } from './voice.js';

export const DIRECT_AI_INSTRUCTION = 'The Discord router selected a direct AI reply for this message. Answer it normally using conversation context. Do not browse, generate images, or return doty_browser_request/doty_image_request markers. Earlier browser or image routing instructions do not apply to this message.';
export const IMAGE_ROUTE_INSTRUCTION = 'The Discord router selected image creation or editing. Prepare the image request from this message and conversation context. Return the doty_image_request JSON described below; do not browse or substitute an existing image.';

export async function decideDiscordRoute(text: string, options: {
  triggerWords: readonly string[]; webAvailable: boolean; jev?: JevConfig; classifier?: ClassifierConfig;
}, fetchImpl: typeof fetch = fetch): Promise<DiscordIntent> {
  const command = parseVoiceCommand(text, options.triggerWords);
  if (command) return { kind: 'command', command };
  if (options.jev) {
    const intent = await classifyDiscordIntentJev(text, options.jev, options.webAvailable, fetchImpl);
    if (intent) return intent.kind === 'web' && !options.webAvailable ? { kind: 'ai' } : intent;
  }
  if (options.classifier && text.split(/\s+/).length <= 12) {
    const fallback = await classifyVoiceIntent(text, options.classifier, fetchImpl);
    if (fallback) return { kind: 'command', command: fallback };
  }
  return { kind: 'ai' };
}
