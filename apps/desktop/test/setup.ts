import { afterEach, beforeEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

// jsdom has the <dialog> element but not the modal API (no showModal, show or close), so every test
// that renders a Dialog would see it permanently closed (#454). This gives it the one behaviour a
// test can observe: the `open` attribute follows show/showModal/close. The inert background and the
// focus trap are the browser's work and are covered by the e2e suite, not here.
if (typeof HTMLDialogElement !== 'undefined') {
  HTMLDialogElement.prototype.show = function show(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    if (!this.hasAttribute('open')) return;
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  };
}

// jsdom's default window is 1024px wide, which is below the width where the sidebar becomes a rail
// (#451). Tests describe the app on an ordinary desktop window unless one says otherwise.
beforeEach(() => {
  // Several suites run in a plain Node environment with no window at all.
  if (typeof window === 'undefined') return;
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 1280 });
});

afterEach(cleanup);
