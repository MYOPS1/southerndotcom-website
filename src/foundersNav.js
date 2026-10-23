export function jumpToFounders(event) {
  if (event && typeof event.preventDefault === 'function') event.preventDefault();
  const target = typeof document !== 'undefined' ? document.getElementById('founders') : null;
  if (target) {
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    const next = typeof window !== 'undefined' ? `${window.location.pathname || '/'}#founders` : '/#founders';
    if (typeof window !== 'undefined') {
      window.history.pushState({}, '', next);
    }
    return;
  }
  if (typeof window !== 'undefined') {
    window.location.assign('/#founders');
  }
}
