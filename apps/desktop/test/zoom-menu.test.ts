import { describe, expect, it } from 'vitest';
import { buildZoomMenuTemplate } from '../electron/zoom-menu.js';

function items() {
  const [view] = buildZoomMenuTemplate();
  return Array.isArray(view?.submenu) ? view.submenu : [];
}

describe('buildZoomMenuTemplate', () => {
  it('keeps zoom in, zoom out and reset on their usual accelerators', () => {
    const accelerators = items().map((item) => [item.role, item.accelerator]);
    expect(accelerators).toContainEqual(['zoomIn', 'CommandOrControl+=']);
    expect(accelerators).toContainEqual(['zoomOut', 'CommandOrControl+-']);
    expect(accelerators).toContainEqual(['resetZoom', 'CommandOrControl+0']);
  });

  it('carries nothing but the zoom roles', () => {
    expect(new Set(items().map((item) => item.role))).toEqual(new Set(['zoomIn', 'zoomOut', 'resetZoom']));
  });
});
