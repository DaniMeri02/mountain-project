# Mobile Panel & Fullscreen Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix two mobile bugs — swipe-down to dismiss the bottom-sheet panel, and broken fullscreen map toggle behavior.

**Architecture:** Three surgical edits across two files. CSS moves the fullscreen panel override into a desktop-only media query so it stops fighting the bottom-sheet's translateY transform. JS adds `e.stopPropagation()` to the toggle button, collapses redundant `resize()` calls to a single `runTransitionResize()`, and attaches one-time touch handlers to the panel element for drag-to-dismiss.

**Tech Stack:** Vanilla JS (ES modules), CSS custom properties, Mapbox GL JS v3, no test framework.

---

## File Map

| File | Change |
|---|---|
| `public/css/style.css` | Move `body.map-fullscreen #panel` rule into `@media (min-width: 768px)` |
| `public/js/main.js` | `e.stopPropagation()` on toggle click; strip 3× redundant `resize()` from `setFullscreenState` |
| `public/js/ui.js` | Add `initPanelSwipeDismiss()` called once on module load |

---

## Task 1: Fix fullscreen panel CSS (mobile conflict)

**Files:**
- Modify: `public/css/style.css`

The rule `body.map-fullscreen #panel { transform: translateX(36px); ... }` currently applies on mobile too. On mobile the panel is a fixed bottom-sheet using `translateY`. Applying `translateX` on top causes broken position, wrong dimensions, and a conflicted transition.

- [ ] **Step 1: Remove the global fullscreen panel rule**

In `public/css/style.css`, find and **delete** this block (it starts around line 355):

```css
body.map-fullscreen #panel {
  opacity: 0;
  transform: translateX(36px);
  padding: 0;
  border-radius: 0;
  pointer-events: none;
}
```

- [ ] **Step 2: Add it back inside the desktop media query**

In `public/css/style.css`, find the `@media (min-width: 768px)` block (around line 844). Inside that block, **after** the existing `#panel { ... }` rule, add:

```css
  body.map-fullscreen #panel {
    opacity: 0;
    transform: translateX(36px);
    padding: 0;
    border-radius: 0;
    pointer-events: none;
  }
```

- [ ] **Step 3: Verify CSS in browser**

Start dev server (`npm run dev`), open on mobile viewport (DevTools → iPhone). Toggle fullscreen. Panel should no longer shift sideways. If a POI panel was open before toggling fullscreen, it should stay at the bottom of the screen (not fly off to the side).

- [ ] **Step 4: Commit**

```bash
git add public/css/style.css
git commit -m "fix(mobile): scope map-fullscreen panel override to desktop only"
```

---

## Task 2: Fix fullscreen toggle button (click leak + resize spam)

**Files:**
- Modify: `public/js/main.js`

Two problems in `setupFullscreenMapOption`:
1. `toggleBtn`'s click handler has no `e.stopPropagation()` — on mobile, the touch event leaks to Mapbox and fires a map click, sometimes opening a POI panel.
2. `setFullscreenState` calls `mapInstance.resize()` three times synchronously plus starts a RAF loop — causes multiple reflows and flicker during transition.

- [ ] **Step 1: Add stopPropagation and strip redundant resizes**

In `public/js/main.js`, replace the entire `setFullscreenState` function and the `toggleBtn` click handler. The current code (around line 124–148) looks like:

```js
const setFullscreenState = (enabled) => {
  mapInstance.stop();
  mapInstance.resize();
  scheduleResize();

  root.classList.toggle('map-fullscreen', enabled);
  mapInstance.resize();
  // ...icon + aria...
  window.dispatchEvent(new Event('layout:changed'));
  scheduleResize();
  runTransitionResize();
};

toggleBtn.addEventListener('click', () => {
  setFullscreenState(!root.classList.contains('map-fullscreen'));
});
```

Replace with:

```js
const setFullscreenState = (enabled) => {
  mapInstance.stop();
  root.classList.toggle('map-fullscreen', enabled);

  const label = enabled ? 'Exit fullscreen map mode' : 'Enter fullscreen map mode';
  toggleBtn.setAttribute('aria-pressed', String(enabled));
  toggleBtn.setAttribute('aria-label', label);
  toggleBtn.title = label;
  toggleBtn.innerHTML = enabled
    ? '<svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><polyline points="1,7 7,7 7,1"/><polyline points="11,1 11,7 17,7"/><polyline points="17,11 11,11 11,17"/><polyline points="7,17 7,11 1,11"/></svg>'
    : '<svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><polyline points="1,7 1,1 7,1"/><polyline points="11,1 17,1 17,7"/><polyline points="17,11 17,17 11,17"/><polyline points="7,17 1,17 1,11"/></svg>';

  window.dispatchEvent(new Event('layout:changed'));
  runTransitionResize();
};

toggleBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  setFullscreenState(!root.classList.contains('map-fullscreen'));
});
```

Note: `scheduleResize` is still wired to `ResizeObserver`, `transitionend`, and `window resize` events — those remain unchanged. Only the calls *inside* `setFullscreenState` are removed.

- [ ] **Step 2: Verify in browser on mobile viewport**

Open mobile viewport in DevTools. Toggle fullscreen several times rapidly. Map should animate smoothly without flickering. No POI panel should appear when tapping the toggle button.

- [ ] **Step 3: Commit**

```bash
git add public/js/main.js
git commit -m "fix(mobile): stopPropagation on fullscreen toggle, remove redundant resize calls"
```

---

## Task 3: Add swipe-down to dismiss panel

**Files:**
- Modify: `public/js/ui.js`

The bottom-sheet panel can only be closed by the X button. Add a drag-to-dismiss gesture: when the panel is scrolled to the top and the user drags down, the panel tracks the finger. If released past 80 px, it closes; otherwise it snaps back.

- [ ] **Step 1: Add initPanelSwipeDismiss function**

In `public/js/ui.js`, add this function **before** the `openPanel` function (i.e. near the top, after the `closePanel` export):

```js
function initPanelSwipeDismiss() {
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
```

- [ ] **Step 2: Call initPanelSwipeDismiss once at module load**

At the bottom of `public/js/ui.js`, just before or after `fetchAiModels()` pre-warm call, add:

```js
initPanelSwipeDismiss();
```

- [ ] **Step 3: Verify in browser on mobile viewport**

Open mobile DevTools, tap a POI to open the panel. Drag from the handle bar downward:
- Release after dragging < 80 px → panel snaps back open
- Release after dragging > 80 px → panel closes
- Scroll inside the panel content (when scrolled down) → normal scroll, no dismiss triggered

- [ ] **Step 4: Commit**

```bash
git add public/js/ui.js
git commit -m "feat(mobile): swipe-down gesture to dismiss bottom-sheet panel"
```
