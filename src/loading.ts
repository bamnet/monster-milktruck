export const LOADING_MESSAGES: readonly string[] = [
  'Reticulating splines...',
  'Pasteurizing 3D terrain...',
  'Pressurizing udder suspension...',
  'Chilling glass bottles...',
  'Calibrating monster tires...',
  'Homogenizing satellite imagery...',
];

const MESSAGE_INTERVAL_MS = 1400;
const FADE_OUT_MS = 450;
const FALLBACK_READY_MS = 8000;

export interface LoadingScreenElements {
  root: HTMLElement | null;
  status: HTMLElement | null;
  barFill: HTMLElement | null;
}

export interface LoadingScreenOptions {
  messages?: readonly string[];
  messageIntervalMs?: number;
  fadeOutMs?: number;
  fallbackReadyMs?: number;
  random?: () => number;
}

export interface LoadingScreenController {
  readonly isComplete: boolean;
  setProgress(percent: number, message?: string): void;
  complete(): void;
  dismissImmediately(): void;
}

export function shuffleMessages(
  messages: readonly string[],
  random: () => number = Math.random,
): string[] {
  const copy = [...messages];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const tmp = copy[i]!;
    copy[i] = copy[j]!;
    copy[j] = tmp;
  }
  return copy;
}

export function createLoadingScreen(
  elements: LoadingScreenElements,
  options: LoadingScreenOptions = {},
): LoadingScreenController {
  const random = options.random ?? Math.random;
  const messages = shuffleMessages(options.messages ?? LOADING_MESSAGES, random);
  const messageIntervalMs = options.messageIntervalMs ?? MESSAGE_INTERVAL_MS;
  const fadeOutMs = options.fadeOutMs ?? FADE_OUT_MS;
  const fallbackReadyMs = options.fallbackReadyMs ?? FALLBACK_READY_MS;

  let completed = false;
  let progress = 12;
  let msgIndex = 0;
  let intervalId: ReturnType<typeof setInterval> | null = null;
  let fadeTimerId: ReturnType<typeof setTimeout> | null = null;
  let fallbackTimerId: ReturnType<typeof setTimeout> | null = null;

  const applyProgress = (pct: number) => {
    progress = Math.max(progress, Math.min(100, Math.round(pct)));
    if (elements.barFill) {
      elements.barFill.style.width = `${progress}%`;
    }
  };

  const applyStatus = (text: string) => {
    if (elements.status) {
      elements.status.textContent = text;
    }
  };

  const clearTimers = () => {
    if (intervalId !== null) {
      clearInterval(intervalId);
      intervalId = null;
    }
    if (fallbackTimerId !== null) {
      clearTimeout(fallbackTimerId);
      fallbackTimerId = null;
    }
    if (fadeTimerId !== null) {
      clearTimeout(fadeTimerId);
      fadeTimerId = null;
    }
  };

  applyProgress(progress);
  if (messages.length > 0) {
    applyStatus(messages[0]!);
  }

  if (messageIntervalMs > 0 && messages.length > 1) {
    intervalId = setInterval(() => {
      if (completed) return;
      msgIndex = (msgIndex + 1) % messages.length;
      applyStatus(messages[msgIndex]!);
      if (progress < 90) {
        applyProgress(progress + 8);
      }
    }, messageIntervalMs);
  }

  if (fallbackReadyMs > 0) {
    fallbackTimerId = setTimeout(() => {
      controller.complete();
    }, fallbackReadyMs);
  }

  const controller: LoadingScreenController = {
    get isComplete() {
      return completed;
    },

    setProgress(percent: number, message?: string) {
      if (completed) return;
      applyProgress(percent);
      if (message !== undefined) {
        applyStatus(message);
      }
    },

    complete() {
      if (completed) return;
      completed = true;
      clearTimers();
      applyProgress(100);
      if (!elements.root) return;
      elements.root.classList.add('is-loaded');
      if (fadeOutMs <= 0) {
        elements.root.hidden = true;
      } else {
        fadeTimerId = setTimeout(() => {
          if (elements.root) {
            elements.root.hidden = true;
          }
        }, fadeOutMs);
      }
    },

    dismissImmediately() {
      completed = true;
      clearTimers();
      if (elements.root) {
        elements.root.classList.add('is-loaded');
        elements.root.hidden = true;
      }
    },
  };

  return controller;
}
