/**
 * T3 pending questions, surfaced locally in Doty's chat.
 *
 * Doty cannot submit the answer: T3's command bus is only exposed to
 * provider-scoped MCP clients, so a watched thread's pending question is shown
 * as a chat card and selecting an option copies it to the clipboard to paste
 * into T3. LOCAL ONLY — the prompt text never leaves the device.
 */
import type { Harness } from '@doty/harness-events';

const HARNESSES: readonly Harness[] = ['codex', 'opencode', 't3'];

export interface QuestionOption {
  label: string;
  description: string;
  value?: string;
}

export interface QuestionPrompt {
  id: string;
  header: string;
  question: string;
  options: QuestionOption[];
  multiSelect?: boolean;
  allowCustomAnswer?: boolean;
}

export interface PendingQuestion {
  harness: Harness;
  sessionId: string;
  requestId: string;
  threadTitle?: string;
  title: string;
  createdAt?: number;
  questions: QuestionPrompt[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readOption(value: unknown): QuestionOption | null {
  if (!isRecord(value) || typeof value.label !== 'string') return null;
  return {
    label: value.label,
    description: typeof value.description === 'string' ? value.description : '',
    ...(typeof value.value === 'string' ? { value: value.value } : {}),
  };
}

function readPrompt(value: unknown): QuestionPrompt | null {
  if (!isRecord(value) || typeof value.question !== 'string') return null;
  const options = Array.isArray(value.options)
    ? value.options.map(readOption).filter((option): option is QuestionOption => option !== null)
    : [];
  return {
    id: typeof value.id === 'string' && value.id ? value.id : 'q0',
    header: typeof value.header === 'string' ? value.header : '',
    question: value.question,
    options,
    ...(typeof value.multiSelect === 'boolean' ? { multiSelect: value.multiSelect } : {}),
    ...(typeof value.allowCustomAnswer === 'boolean' ? { allowCustomAnswer: value.allowCustomAnswer } : {}),
  };
}

/** Whitelist one pending question; drops unknown keys and malformed entries. */
export function readPendingQuestion(value: unknown): PendingQuestion | null {
  if (!isRecord(value)) return null;
  if (!(HARNESSES as readonly unknown[]).includes(value.harness)) return null;
  if (typeof value.sessionId !== 'string' || !value.sessionId) return null;
  if (typeof value.requestId !== 'string' || !value.requestId) return null;
  const questions = Array.isArray(value.questions)
    ? value.questions.map(readPrompt).filter((prompt): prompt is QuestionPrompt => prompt !== null)
    : [];
  if (questions.length === 0) return null;
  return {
    harness: value.harness as Harness,
    sessionId: value.sessionId,
    requestId: value.requestId,
    title: typeof value.title === 'string' ? value.title : 'User input',
    questions,
    ...(typeof value.threadTitle === 'string' ? { threadTitle: value.threadTitle } : {}),
    ...(typeof value.createdAt === 'number' && Number.isFinite(value.createdAt)
      ? { createdAt: value.createdAt }
      : {}),
  };
}

export function readPendingQuestions(value: unknown): PendingQuestion[] {
  if (!Array.isArray(value)) return [];
  const out: PendingQuestion[] = [];
  for (const entry of value) {
    const question = readPendingQuestion(entry);
    if (question) out.push(question);
  }
  return out;
}

/** Copy text to the clipboard, returning whether it succeeded. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Secure-context or permission failure — fall through to selection copy.
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.top = '0';
    area.style.opacity = '0';
    document.body.append(area);
    area.focus();
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

/**
 * Render one pending question as a chat row (`<li class="msg msg-question">`).
 * Options — and a free-text answer when T3 allows it — answer the question from
 * Doty by enqueuing T3's own runtime-request effect.
 */
export function createQuestionRow(question: PendingQuestion): HTMLLIElement {
  const row = document.createElement('li');
  row.className = 'msg msg-question';
  row.dataset.requestId = question.requestId;

  const status = document.createElement('span');
  status.className = 'question-status';
  status.textContent = 'Responde aquí: T3 la recibe al momento.';

  const where = question.threadTitle?.trim() || question.sessionId.slice(0, 8);
  const meta = document.createElement('span');
  meta.className = 'msg-meta question-meta';
  meta.textContent = `T3 · ${where} · esperando respuesta`;
  row.append(meta);

  for (const prompt of question.questions) {
    if (prompt.header) {
      const header = document.createElement('span');
      header.className = 'question-header';
      header.textContent = prompt.header;
      row.append(header);
    }
    const text = document.createElement('span');
    text.className = 'question-text';
    text.textContent = prompt.question;
    row.append(text);

    const options = document.createElement('div');
    options.className = 'question-options';
    const buttons: HTMLButtonElement[] = [];
    for (const option of prompt.options) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'question-option';

      const label = document.createElement('span');
      label.className = 'qopt-label';
      label.textContent = option.label;
      button.append(label);

      if (option.description) {
        const description = document.createElement('span');
        description.className = 'qopt-desc';
        description.textContent = option.description;
        button.append(description);
      }

      button.addEventListener('click', () => {
        for (const sibling of buttons) sibling.classList.toggle('is-copied', sibling === button);
        void sendAnswer(row, status, question, prompt, (option.value ?? option.label).trim());
      });
      buttons.push(button);
      options.append(button);
    }
    row.append(options);

    if (prompt.allowCustomAnswer) {
      const form = document.createElement('form');
      form.className = 'question-custom';
      const input = document.createElement('input');
      input.type = 'text';
      input.placeholder = 'Otra respuesta…';
      input.maxLength = 2000;
      input.autocomplete = 'off';
      const send = document.createElement('button');
      send.type = 'submit';
      send.textContent = 'Enviar';
      form.append(input, send);
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        const value = input.value.trim();
        if (!value) return;
        for (const sibling of buttons) sibling.classList.remove('is-copied');
        void sendAnswer(row, status, question, prompt, value);
      });
      row.append(form);
    }
  }

  row.append(status);
  return row;
}

function setStatus(element: HTMLElement | null | undefined, text: string, tone: 'pending' | 'ok' | 'error'): void {
  if (!element) return;
  element.textContent = text;
  element.classList.toggle('is-copied', tone === 'ok');
  element.classList.toggle('is-error', tone === 'error');
}

/** Enqueue the answer through T3; fall back to copying if that fails. */
async function sendAnswer(
  row: HTMLLIElement,
  status: HTMLElement,
  question: PendingQuestion,
  prompt: QuestionPrompt,
  value: string,
): Promise<void> {
  setStatus(status, 'Enviando a T3…', 'pending');
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('answer_question', {
      threadId: question.sessionId,
      requestId: question.requestId,
      questionId: prompt.id,
      value,
    });
    setStatus(status, `Respuesta enviada: «${value}». T3 la está procesando.`, 'ok');
    row.classList.add('is-sent');
  } catch {
    // Never lose the answer: fall back to copying it.
    const copied = await copyText(value);
    setStatus(
      status,
      copied
        ? 'No se pudo enviar automáticamente; copiado al portapapeles.'
        : 'No se pudo enviar ni copiar la respuesta.',
      'error',
    );
  }
}

/**
 * Subscribe to pending questions over local IPC. Returns an unsubscribe
 * function. A no-op outside the desktop shell.
 */
export function subscribeQuestions(onChange: (questions: PendingQuestion[]) => void): () => void {
  if (!('__TAURI_INTERNALS__' in window)) return () => {};
  let destroyed = false;
  let unlisten: (() => void) | undefined;

  void (async () => {
    try {
      const [{ listen }, { invoke }] = await Promise.all([
        import('@tauri-apps/api/event'),
        import('@tauri-apps/api/core'),
      ]);
      if (destroyed) return;
      // Buffer live updates while the snapshot loads so a race cannot lose one.
      let hydrating = true;
      const buffered: unknown[] = [];
      const stop = await listen<unknown>('harness://questions', ({ payload }) => {
        if (destroyed) return;
        if (hydrating) buffered.push(payload);
        else onChange(readPendingQuestions(payload));
      });
      if (destroyed) {
        stop();
        return;
      }
      unlisten = stop;
      try {
        onChange(readPendingQuestions(await invoke<unknown>('harness_questions')));
      } finally {
        hydrating = false;
        if (!destroyed) {
          for (const payload of buffered) onChange(readPendingQuestions(payload));
        }
      }
    } catch {
      // No pending-question bridge; leave the chat unchanged.
    }
  })();

  return () => {
    destroyed = true;
    unlisten?.();
  };
}
