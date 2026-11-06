import { describe, expect, test } from 'bun:test';
import { createInput } from './input.ts';

function createKeyEvent(type: 'keydown' | 'keyup', key: string) {
  let propagationStopped = false;
  let immediateStopped = false;
  const base = new Event(type, { bubbles: true, cancelable: true });
  const origStop = base.stopPropagation.bind(base);
  const origStopImmediate = base.stopImmediatePropagation.bind(base);

  return Object.assign(base, {
    key,
    stopPropagation() {
      propagationStopped = true;
      origStop();
    },
    stopImmediatePropagation() {
      immediateStopped = true;
      origStopImmediate();
    },
    wasPropagationStopped: () => propagationStopped,
    wasImmediatePropagationStopped: () => immediateStopped,
  });
}

function createFakeDom() {
  const rawWin = new EventTarget();
  const listenerOptions: Array<{ type: string; options: AddEventListenerOptions | boolean | undefined }> = [];
  const win = {
    addEventListener(
      type: string,
      callback: EventListenerOrEventListenerObject | null,
      options?: AddEventListenerOptions | boolean,
    ) {
      listenerOptions.push({ type, options });
      rawWin.addEventListener(type, callback, options);
    },
    removeEventListener: rawWin.removeEventListener.bind(rawWin),
    dispatchEvent: rawWin.dispatchEvent.bind(rawWin),
  } as EventTarget;

  const buttons: Record<string, EventTarget> = {
    'btn-gas': new EventTarget(),
    'btn-left': new EventTarget(),
    'btn-right': new EventTarget(),
    'btn-reverse': new EventTarget(),
  };

  return {
    win,
    buttons,
    listenerOptions,
    dom: {
      win,
      getElementById(id: string) {
        return buttons[id] ?? null;
      },
    },
  };
}

describe('createInput', () => {
  test('maps arrow and WASD keys (both cases) on keydown and clears independently on keyup', () => {
    const { win, dom } = createFakeDom();
    const state = createInput(dom);

    const cases: Array<{ key: string; field: keyof typeof state }> = [
      { key: 'ArrowUp', field: 'gas' },
      { key: 'w', field: 'gas' },
      { key: 'W', field: 'gas' },
      { key: 'ArrowDown', field: 'reverse' },
      { key: 's', field: 'reverse' },
      { key: 'S', field: 'reverse' },
      { key: 'ArrowLeft', field: 'left' },
      { key: 'a', field: 'left' },
      { key: 'A', field: 'left' },
      { key: 'ArrowRight', field: 'right' },
      { key: 'd', field: 'right' },
      { key: 'D', field: 'right' },
    ];

    for (const { key, field } of cases) {
      win.dispatchEvent(createKeyEvent('keydown', key));
      expect(state[field]).toBe(true);
      win.dispatchEvent(createKeyEvent('keyup', key));
      expect(state[field]).toBe(false);
    }
  });

  test('registers key listeners in capture phase and stops mapped keys from reaching downstream listeners', () => {
    const { win, dom, listenerOptions } = createFakeDom();
    createInput(dom);

    const keydownReg = listenerOptions.find((entry) => entry.type === 'keydown');
    const keyupReg = listenerOptions.find((entry) => entry.type === 'keyup');
    expect(keydownReg?.options).toEqual({ capture: true });
    expect(keyupReg?.options).toEqual({ capture: true });

    let downstreamFired = false;
    win.addEventListener('keydown', () => {
      downstreamFired = true;
    });

    const arrowEvent = createKeyEvent('keydown', 'ArrowUp');
    win.dispatchEvent(arrowEvent);

    expect(arrowEvent.defaultPrevented).toBe(true);
    expect(arrowEvent.wasPropagationStopped()).toBe(true);
    expect(arrowEvent.wasImmediatePropagationStopped()).toBe(true);
    expect(downstreamFired).toBe(false);
  });

  test('ignores unmapped keys without preventing default or blocking downstream listeners', () => {
    const { win, dom } = createFakeDom();
    const state = createInput(dom);

    let downstreamCount = 0;
    win.addEventListener('keydown', () => {
      downstreamCount++;
    });

    for (const key of ['Escape', 'Tab', 'Enter', ' ', 'x']) {
      const ev = createKeyEvent('keydown', key);
      win.dispatchEvent(ev);
      expect(ev.defaultPrevented).toBe(false);
      expect(ev.wasPropagationStopped()).toBe(false);
    }

    expect(downstreamCount).toBe(5);
    expect(state).toEqual({ left: false, right: false, gas: false, reverse: false });
  });

  test('resets all active inputs when window loses focus (blur)', () => {
    const { win, dom } = createFakeDom();
    const state = createInput(dom);

    win.dispatchEvent(createKeyEvent('keydown', 'ArrowUp'));
    win.dispatchEvent(createKeyEvent('keydown', 'ArrowRight'));
    expect(state).toEqual({ left: false, right: true, gas: true, reverse: false });

    win.dispatchEvent(new Event('blur'));
    expect(state).toEqual({ left: false, right: false, gas: false, reverse: false });
  });

  test('binds mouse and touch events on on-screen control buttons and tolerates missing elements', () => {
    const { buttons, dom } = createFakeDom();
    const state = createInput(dom);

    const gasBtn = buttons['btn-gas']!;
    gasBtn.dispatchEvent(new Event('mousedown'));
    expect(state.gas).toBe(true);
    gasBtn.dispatchEvent(new Event('mouseleave'));
    expect(state.gas).toBe(false);

    const leftBtn = buttons['btn-left']!;
    leftBtn.dispatchEvent(new Event('mousedown'));
    expect(state.left).toBe(true);
    leftBtn.dispatchEvent(new Event('mouseup'));
    expect(state.left).toBe(false);

    const reverseBtn = buttons['btn-reverse']!;
    const touchStart = new Event('touchstart', { cancelable: true });
    reverseBtn.dispatchEvent(touchStart);
    expect(touchStart.defaultPrevented).toBe(true);
    expect(state.reverse).toBe(true);

    const touchEnd = new Event('touchend', { cancelable: true });
    reverseBtn.dispatchEvent(touchEnd);
    expect(touchEnd.defaultPrevented).toBe(true);
    expect(state.reverse).toBe(false);

    const rightBtn = buttons['btn-right']!;
    rightBtn.dispatchEvent(new Event('touchstart', { cancelable: true }));
    expect(state.right).toBe(true);
    rightBtn.dispatchEvent(new Event('touchcancel'));
    expect(state.right).toBe(false);

    // Missing buttons should not throw
    const emptyState = createInput({ win: new EventTarget(), getElementById: () => null });
    expect(emptyState).toEqual({ left: false, right: false, gas: false, reverse: false });
  });
});
