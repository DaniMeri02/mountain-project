const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

let _close: () => void = () => {};

export function closeNav(): void {
  _close();
}

export function initNav(): void {
  const burger = document.getElementById('nav-burger');
  const drawer = document.getElementById('nav-drawer');
  const closeBtn = document.getElementById('nav-drawer-close');
  const backdrop = document.getElementById('nav-backdrop');
  if (!burger || !drawer || !backdrop) return;

  let lastFocus: Element | null = null;

  function open(): void {
    lastFocus = document.activeElement;
    drawer!.classList.add('open');
    drawer!.setAttribute('aria-hidden', 'false');
    burger!.setAttribute('aria-expanded', 'true');
    backdrop!.hidden = false;
    requestAnimationFrame(() => backdrop!.classList.add('show'));
    document.body.style.overflow = 'hidden';
    const first = drawer!.querySelector(FOCUSABLE);
    if (first) (first as HTMLElement).focus();
  }

  function close(): void {
    drawer!.classList.remove('open');
    drawer!.setAttribute('aria-hidden', 'true');
    burger!.setAttribute('aria-expanded', 'false');
    backdrop!.classList.remove('show');
    document.body.style.overflow = '';
    setTimeout(() => { backdrop!.hidden = true; }, 220);
    if (lastFocus && typeof (lastFocus as HTMLElement).focus === 'function') (lastFocus as HTMLElement).focus();
  }

  _close = close;

  burger.addEventListener('click', () => {
    drawer!.classList.contains('open') ? close() : open();
  });
  closeBtn?.addEventListener('click', close);
  backdrop.addEventListener('click', close);

  document.addEventListener('keydown', (e) => {
    if (!drawer!.classList.contains('open')) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
      return;
    }
    if (e.key === 'Tab') {
      const items = [...drawer!.querySelectorAll(FOCUSABLE)].filter(el => !(el as HTMLInputElement).disabled);
      if (items.length === 0) return;
      const first = items[0] as HTMLElement;
      const last = items[items.length - 1] as HTMLElement;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  });

  drawer.querySelectorAll('input[name="map-style"]').forEach((el) => {
    el.addEventListener('change', () => {
      if (window.matchMedia('(max-width: 767px)').matches) close();
    });
  });
}
