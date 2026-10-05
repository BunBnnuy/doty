/**
 * Vite demo for `@doty/avatar`.
 *
 * Run with `npm -w @doty/avatar run dev`. Click through every activity and
 * emotion, toggle speech/progress/connection, and watch the mascot morph. There is
 * no backend: the demo drives the frozen `@doty/dot-state` store directly.
 */

import { createDotStore, startFakeDriver } from '@doty/dot-state';
import type { Activity, Connection, DotState, Emotion, Speech } from '@doty/dot-state';
import { mountAvatar } from './index.js';
import type { AvatarHandle } from './index.js';

const ACTIVITIES: readonly Activity[] = [
  'idle',
  'listening',
  'thinking',
  'working',
  'speaking',
  'waiting_approval',
  'done',
  'error',
];

const EMOTIONS: readonly Emotion[] = ['neutral', 'happy', 'curious', 'concerned', 'focused'];

const CONNECTIONS: readonly Connection[] = ['online', 'reconnecting', 'offline'];

const VISEMES: readonly string[] = ['rest', 'AA', 'E', 'I', 'O', 'U', 'MBP', 'FV', 'L', 'WQ'];

function tag<K extends keyof HTMLElementTagNameMap>(
  name: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(name);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label: string, onClick: () => void): HTMLButtonElement {
  const node = tag('button', undefined, label);
  node.type = 'button';
  node.addEventListener('click', onClick);
  return node;
}

const app = document.getElementById('app');
if (!app) throw new Error('demo: #app not found');

const store = createDotStore();

// --- layout ----------------------------------------------------------------

const header = tag('header');
header.append(tag('h1', undefined, 'Doty'), tag('p', 'sub', 'Two eyes. One little star. Flat SVG, no assets, no mouth.'));

const stage = tag('section', 'stage');
const mount = tag('div', 'mount');
const caption = tag('div', 'caption');
const smallMount = tag('div', 'small-mount');
stage.append(mount, smallMount, tag('p', 'sub', 'Also shown at 48px and 80px'), caption);

const controls = tag('section', 'controls');
const layout = tag('div', 'layout');
layout.append(stage, controls);
app.className = 'app';
app.append(header, layout);

// --- activity --------------------------------------------------------------

const activityGroup = tag('div', 'group');
activityGroup.append(tag('h2', undefined, 'Activity'));
const activityRow = tag('div', 'row');
const activityButtons = new Map<Activity, HTMLButtonElement>();
for (const activity of ACTIVITIES) {
  const b = button(activity.replace(/_/g, ' '), () =>
    store.dispatch({ type: 'activity', value: activity, label: activity === 'idle' ? null : activity.replace(/_/g, ' ') }),
  );
  activityButtons.set(activity, b);
  activityRow.append(b);
}
activityGroup.append(activityRow);

// --- emotion ---------------------------------------------------------------

const emotionGroup = tag('div', 'group');
emotionGroup.append(tag('h2', undefined, 'Emotion'));
const emotionRow = tag('div', 'row');
const emotionButtons = new Map<Emotion, HTMLButtonElement>();
for (const emotion of EMOTIONS) {
  const b = button(emotion, () => store.dispatch({ type: 'emotion', value: emotion }));
  emotionButtons.set(emotion, b);
  emotionRow.append(b);
}
emotionGroup.append(emotionRow);

// --- speech ----------------------------------------------------------------

const speechGroup = tag('div', 'group');
speechGroup.append(tag('h2', undefined, 'Speech → eye squint (independent)'));
const speechToggleLabel = tag('label', 'check');
const speechToggle = tag('input');
speechToggle.type = 'checkbox';
speechToggleLabel.append(speechToggle, document.createTextNode('speaking'));
speechGroup.append(speechToggleLabel);

const visemeSelect = tag('select');
for (const viseme of VISEMES) {
  const option = tag('option', undefined, viseme);
  option.value = viseme;
  visemeSelect.append(option);
}
visemeSelect.value = 'AA';

const energyRange = tag('input');
energyRange.type = 'range';
energyRange.min = '0';
energyRange.max = '1';
energyRange.step = '0.01';
energyRange.value = '0.8';

const energyValue = tag('span', undefined, '0.80');
const visemeLabel = tag('label', 'control');
visemeLabel.append(tag('span', undefined, 'viseme'), visemeSelect, tag('span'));
const energyLabel = tag('label', 'control');
energyLabel.append(tag('span', undefined, 'energy'), energyRange, energyValue);
speechGroup.append(visemeLabel, energyLabel);

function currentSpeech(): Speech | null {
  if (!speechToggle.checked) return null;
  return { viseme: visemeSelect.value, energy: Number(energyRange.value) };
}
speechToggle.addEventListener('change', () => store.dispatch({ type: 'speech', value: currentSpeech() }));
visemeSelect.addEventListener('change', () => store.dispatch({ type: 'speech', value: currentSpeech() }));
energyRange.addEventListener('input', () => {
  energyValue.textContent = Number(energyRange.value).toFixed(2);
  if (speechToggle.checked) store.dispatch({ type: 'speech', value: currentSpeech() });
});

// --- progress --------------------------------------------------------------

const progressGroup = tag('div', 'group');
progressGroup.append(tag('h2', undefined, 'Progress (working)'));
const progressRange = tag('input');
progressRange.type = 'range';
progressRange.min = '0';
progressRange.max = '1';
progressRange.step = '0.01';
progressRange.value = '0.35';
const progressValue = tag('span', undefined, '0.35');
const progressLabel = tag('label', 'control');
progressLabel.append(tag('span', undefined, 'progress'), progressRange, progressValue);
progressGroup.append(progressLabel);
progressRange.addEventListener('input', () => {
  progressValue.textContent = Number(progressRange.value).toFixed(2);
  store.dispatch({ type: 'progress', value: Number(progressRange.value) });
});

// --- connection ------------------------------------------------------------

const connectionGroup = tag('div', 'group');
connectionGroup.append(tag('h2', undefined, 'Connection'));
const connectionRow = tag('div', 'row');
const connectionButtons = new Map<Connection, HTMLButtonElement>();
for (const connection of CONNECTIONS) {
  const b = button(connection, () => store.dispatch({ type: 'connection', value: connection }));
  connectionButtons.set(connection, b);
  connectionRow.append(b);
}
connectionGroup.append(connectionRow);

// --- demo driver + reduced motion -----------------------------------------

const driverGroup = tag('div', 'group');
driverGroup.append(tag('h2', undefined, 'Demo'));

let stopDriver: (() => void) | null = null;
const cycleButton = button('auto-cycle', () => {
  if (stopDriver) {
    stopDriver();
    stopDriver = null;
    cycleButton.classList.remove('active');
  } else {
    stopDriver = startFakeDriver(store, 1600);
    cycleButton.classList.add('active');
  }
});

const resetButton = button('reset', () => store.dispatch({ type: 'reset' }));
const reducedLabel = tag('label', 'check');
const reducedToggle = tag('input');
reducedToggle.type = 'checkbox';
reducedToggle.checked = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
reducedLabel.append(reducedToggle, document.createTextNode('prefers-reduced-motion'));
const demoRow = tag('div', 'row');
demoRow.append(cycleButton, resetButton);
driverGroup.append(demoRow, reducedLabel);

const statePreview = tag('pre');
driverGroup.append(statePreview);

controls.append(activityGroup, emotionGroup, speechGroup, progressGroup, connectionGroup, driverGroup);

// --- mounting --------------------------------------------------------------

let handle: AvatarHandle;
let smallHandles: AvatarHandle[] = [];

function remount(): void {
  handle?.destroy();
  for (const smallHandle of smallHandles) smallHandle.destroy();
  handle = mountAvatar(mount, store, { size: 240, reducedMotion: reducedToggle.checked });
  smallHandles = [48, 80].map((size) => mountAvatar(smallMount, store, { size, reducedMotion: reducedToggle.checked }));
  Object.assign(window, { dotyAvatar: handle });
}
remount();
reducedToggle.addEventListener('change', remount);

// Static contact sheet makes every activity/emotion combination inspectable.
// Clicking one changes only those axes: existing speech and connection survive.
const poses = tag('section', 'poses');
poses.append(tag('h2', undefined, 'All 40 static poses'), tag('p', 'sub', 'Click any pose to try it above. Speech and connection stay untouched.'));
const poseGrid = tag('div', 'pose-grid');
for (const activity of ACTIVITIES) {
  for (const emotion of EMOTIONS) {
    const pose = button('', () => {
      store.dispatch({ type: 'activity', value: activity });
      store.dispatch({ type: 'emotion', value: emotion });
    });
    pose.className = 'pose';
    pose.setAttribute('aria-label', `${activity.replace(/_/g, ' ')} · ${emotion}`);
    mountAvatar(pose, { subscribe(listener) { listener({ activity, emotion }); return () => {}; } }, { size: 64, reducedMotion: true });
    pose.append(tag('span', undefined, activity.replace(/_/g, ' ')), tag('span', 'sub', emotion));
    poseGrid.append(pose);
  }
}
poses.append(poseGrid);
app.append(poses);

// Keep the control panel in sync with the store.
store.subscribe((state: DotState) => {
  for (const [activity, b] of activityButtons) {
    b.classList.toggle('active', activity === state.activity);
    b.setAttribute('aria-pressed', String(activity === state.activity));
  }
  for (const [emotion, b] of emotionButtons) {
    b.classList.toggle('active', emotion === state.emotion);
    b.setAttribute('aria-pressed', String(emotion === state.emotion));
  }
  for (const [connection, b] of connectionButtons) {
    b.classList.toggle('active', connection === (state.connection ?? 'online'));
    b.setAttribute('aria-pressed', String(connection === (state.connection ?? 'online')));
  }

  speechToggle.checked = Boolean(state.speech);
  if (state.speech) {
    visemeSelect.value = state.speech.viseme;
    energyRange.value = String(state.speech.energy);
    energyValue.textContent = state.speech.energy.toFixed(2);
  }
  if (typeof state.progress === 'number') {
    progressRange.value = String(state.progress);
    progressValue.textContent = state.progress.toFixed(2);
  }

  caption.innerHTML = '';
  caption.append(
    document.createTextNode('activity '),
    Object.assign(tag('strong'), { textContent: state.activity }),
    document.createTextNode(' · emotion '),
    Object.assign(tag('strong'), { textContent: state.emotion }),
    document.createTextNode(state.connection && state.connection !== 'online' ? ` · ${state.connection}` : ''),
  );
  statePreview.textContent = JSON.stringify(state, null, 2);
});

// Expose for tinkering in the console.
Object.assign(window, { dotyStore: store });
