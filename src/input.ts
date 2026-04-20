export interface InputState {
  left: boolean;
  right: boolean;
  gas: boolean;
  reverse: boolean;
}

const KEY_MAP: Record<string, keyof InputState> = {
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'gas',
  ArrowDown: 'reverse',
  a: 'left',
  A: 'left',
  d: 'right',
  D: 'right',
  w: 'gas',
  W: 'gas',
  s: 'reverse',
  S: 'reverse',
};

export function createInput(): InputState {
  const state: InputState = { left: false, right: false, gas: false, reverse: false };

  const onKey = (down: boolean) => (e: KeyboardEvent) => {
    const field = KEY_MAP[e.key];
    if (!field) return;
    state[field] = down;
    e.preventDefault();
  };

  window.addEventListener('keydown', onKey(true));
  window.addEventListener('keyup', onKey(false));

  const bindButton = (id: string, field: keyof InputState) => {
    const el = document.getElementById(id);
    if (!el) return;
    const on = () => { state[field] = true; };
    const off = () => { state[field] = false; };
    el.addEventListener('mousedown', on);
    el.addEventListener('mouseup', off);
    el.addEventListener('mouseleave', off);
    el.addEventListener('touchstart', (e) => { e.preventDefault(); on(); }, { passive: false });
    el.addEventListener('touchend', (e) => { e.preventDefault(); off(); });
    el.addEventListener('touchcancel', off);
  };

  bindButton('btn-gas', 'gas');
  bindButton('btn-left', 'left');
  bindButton('btn-right', 'right');
  bindButton('btn-reverse', 'reverse');

  return state;
}
