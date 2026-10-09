/** Manual image test. Does not start the API or send a Discord message. */
import { CodexImageGenerator } from './codex-images.js';

const file = await new CodexImageGenerator().generate('A simple blue circle on a white background, no text.');
console.log(JSON.stringify({ filename: file.filename, bytes: file.data.length, mime: file.mime }));
