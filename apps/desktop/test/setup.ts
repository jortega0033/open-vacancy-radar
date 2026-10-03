import { afterEach, beforeEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

// jsdom's default window is 1024px wide, which is below the width where the sidebar becomes a rail
// (#451). Tests describe the app on an ordinary desktop window unless one says otherwise.
beforeEach(() => {
  // Several suites run in a plain Node environment with no window at all.
  if (typeof window === 'undefined') return;
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 1280 });
});

afterEach(cleanup);
