import { describe, expect, it } from 'vitest';
import { readPendingQuestion, readPendingQuestions } from './questions.js';

const sample = {
  harness: 't3',
  sessionId: 'thread-1',
  requestId: 'req-1',
  threadTitle: 'Doty',
  title: 'User input',
  createdAt: 1_000,
  questions: [
    {
      id: 'q0',
      header: 'Siguiente paso',
      question: '¿Seguimos?',
      options: [
        { label: 'Sí', description: 'continuar', value: 'yes' },
        { label: 'No', description: 'parar' },
      ],
      multiSelect: false,
      allowCustomAnswer: true,
    },
  ],
};

describe('pending question read model', () => {
  it('whitelists the shape and drops unknown keys', () => {
    const clean = readPendingQuestion({ ...sample, text: 'PRIVATE', extra: 'PRIVATE' });
    expect(clean).toEqual(sample);
    expect(JSON.stringify(clean)).not.toContain('PRIVATE');
  });

  it('rejects malformed entries', () => {
    for (const bad of [
      null,
      [],
      { ...sample, harness: 'unknown' },
      { ...sample, sessionId: '' },
      { ...sample, requestId: '' },
      { ...sample, questions: [] },
      { ...sample, questions: [{ header: 'x' }] },
    ]) {
      expect(readPendingQuestion(bad)).toBeNull();
    }
  });

  it('reads a list and keeps only valid entries', () => {
    expect(readPendingQuestions([sample, { nope: true }])).toHaveLength(1);
    expect(readPendingQuestions('nope')).toEqual([]);
  });
});
