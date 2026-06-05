// Single owner of the detail panel's open/close state and bottom-sheet swipe-dismiss.
// `body.panel-open` is the shared signal (CSS drives the slide-in; routing observes it),
// so every consumer should toggle it through here rather than poking classList directly.

const PANEL_OPEN_CLASS = 'panel-open';

const DEFAULT_PANEL_HTML = `
  <h2>Location Details</h2>
  <p>Select a location on the map to view more information here.</p>
`;

export function openPanel(): void {
  document.body.classList.add(PANEL_OPEN_CLASS);
}

export function closePanel(): void {
  document.body.classList.remove(PANEL_OPEN_CLASS);
  const panel = document.getElementById('panel');
  if (panel) panel.innerHTML = DEFAULT_PANEL_HTML;
}

export function isPanelOpen(): boolean {
  return document.body.classList.contains(PANEL_OPEN_CLASS);
}

// Wire the bottom-sheet swipe-to-dismiss once, after the DOM is ready.
export function initPanel(): void {
  const panel = document.getElementById('panel');
  if (!panel) return;

  let startY = 0;
  let dragging = false;

  panel.addEventListener('touchstart', (e) => {
    startY = e.touches[0].clientY;
    dragging = false;
  }, { passive: true });

  panel.addEventListener('touchmove', (e) => {
    const dy = e.touches[0].clientY - startY;
    if (panel.scrollTop === 0 && dy > 0) {
      dragging = true;
      panel.style.transition = 'none';
      panel.style.transform = `translateY(${dy}px)`;
      e.preventDefault();
    }
  }, { passive: false });

  panel.addEventListener('touchend', (e) => {
    panel.style.transition = '';
    panel.style.transform = '';
    if (dragging && (e.changedTouches[0].clientY - startY) > 80) {
      closePanel();
    }
    dragging = false;
  }, { passive: true });
}
