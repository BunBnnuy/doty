import 'dotenv/config';
import { classifyDiscordIntentJev, JEV_DEFAULT_MODEL, JEV_DEFAULT_URL } from './command-classifier.js';

if (!process.env.JEV_API_KEY?.trim()) throw new Error('JEV routing check requires runtime configuration');
const config = {
  apiKey: process.env.JEV_API_KEY.trim(),
  baseUrl: process.env.JEV_BASE_URL?.trim() || JEV_DEFAULT_URL,
  model: process.env.JEV_MODEL?.trim() || JEV_DEFAULT_MODEL,
  ...(process.env.OPENAI_USER_AGENT?.trim() ? { userAgent: process.env.OPENAI_USER_AGENT.trim() } : {}),
  ...(process.env.OPENAI_SESSION_ID?.trim() ? { sessionId: process.env.OPENAI_SESSION_ID.trim() } : {}),
};
const cases = [
  ['hola, como estas?', 'ai'],
  ['Explicame que es una API REST', 'ai'],
  ['Puedes generar imagenes?', 'ai'],
  ['busca el meme de goldship y sus papas', 'web'],
  ['Busca en internet el ultimo anuncio de Tibo sobre los limites de Codex', 'web'],
  ['Genera una imagen de un conejo astronauta y mandamela por DM', 'image'],
  ['Edita la imagen adjunta para que el fondo sea azul', 'image'],
  ['Quiero escuchar bachata', 'command'],
] as const;
for (const [text, expected] of cases) {
  const result = await classifyDiscordIntentJev(text, config, true);
  if (result?.kind !== expected || (expected === 'command' && result.kind === 'command' && result.command.cmd !== 'play'))
    throw new Error(`JEV routing check failed: expected ${expected}, received ${result?.kind || 'no decision'}`);
}
console.log('JEV routing smoke: direct AI, existing-image search, current web lookup, image creation/editing and music command decisions passed');
