import { describe, expect, test } from 'bun:test';
import { createLoadingScreen, LOADING_MESSAGES, shuffleMessages } from './loading.ts';

function createFakeLoadingElements() {
  const classes = new Set<string>();
  const root = {
    hidden: false,
    classList: {
      add(cls: string) {
        classes.add(cls);
      },
      contains(cls: string) {
        return classes.has(cls);
      },
    },
  } as unknown as HTMLElement;

  const status = {
    textContent: '',
  } as unknown as HTMLElement;

  const barFill = {
    style: { width: '' },
  } as unknown as HTMLElement;

  return { root, status, barFill, classes };
}

describe('createLoadingScreen', () => {
  test('shuffles loading phrases and advances progress monotonically', () => {
    const els = createFakeLoadingElements();
    // random() = 0 shifts each element in Fisher-Yates so the order rotates deterministically
    const loading = createLoadingScreen(els, {
      messageIntervalMs: 0,
      fallbackReadyMs: 0,
      fadeOutMs: 0,
      random: () => 0,
    });

    expect(LOADING_MESSAGES).toContain('Reticulating splines...');
    expect(LOADING_MESSAGES).toContain(els.status.textContent ?? '');
    expect(els.barFill.style.width).toBe('12%');
    expect(loading.isComplete).toBe(false);

    loading.setProgress(45);
    expect(els.barFill.style.width).toBe('45%');

    // Progress never moves backward
    loading.setProgress(20);
    expect(els.barFill.style.width).toBe('45%');

    loading.setProgress(80, 'Chilling glass bottles...');
    expect(els.barFill.style.width).toBe('80%');
    expect(els.status.textContent).toBe('Chilling glass bottles...');

    loading.complete();
    expect(loading.isComplete).toBe(true);
    expect(els.barFill.style.width).toBe('100%');
    expect(els.classes.has('is-loaded')).toBe(true);
    expect(els.root.hidden).toBe(true);
  });

  test('shuffleMessages produces a valid permutation and varies order with RNG', () => {
    const a = shuffleMessages(LOADING_MESSAGES, () => 0);
    const b = shuffleMessages(LOADING_MESSAGES, () => 0.999);

    expect([...a].sort()).toEqual([...LOADING_MESSAGES].sort());
    expect([...b].sort()).toEqual([...LOADING_MESSAGES].sort());
    expect(a).not.toEqual(b);
  });

  test('cycles through shuffled status messages on interval and stops after complete()', async () => {
    const els = createFakeLoadingElements();
    const loading = createLoadingScreen(els, {
      messages: ['Reticulating splines...', 'Pasteurizing 3D terrain...'],
      messageIntervalMs: 15,
      fallbackReadyMs: 0,
      fadeOutMs: 0,
      random: () => 0, // swaps the two messages -> ['Pasteurizing 3D terrain...', 'Reticulating splines...']
    });

    expect(els.status.textContent).toBe('Pasteurizing 3D terrain...');
    await new Promise((r) => setTimeout(r, 25));
    expect(els.status.textContent).toBe('Reticulating splines...');

    loading.complete();
    expect(loading.isComplete).toBe(true);
  });

  test('dismissImmediately hides the loading screen right away on fatal errors', () => {
    const els = createFakeLoadingElements();
    const loading = createLoadingScreen(els, {
      messageIntervalMs: 0,
      fallbackReadyMs: 0,
      fadeOutMs: 500,
    });

    loading.dismissImmediately();
    expect(loading.isComplete).toBe(true);
    expect(els.classes.has('is-loaded')).toBe(true);
    expect(els.root.hidden).toBe(true);
  });
});
