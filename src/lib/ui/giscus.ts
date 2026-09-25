/** Inject the Giscus client when the discussion block approaches the viewport. */
export function mountGiscus() {
  const host = document.querySelector<HTMLElement>('[data-giscus]');
  if (!host || host.dataset.ready) return;
  host.dataset.ready = '1';
  const load = () => {
    const s = document.createElement('script');
    s.src = 'https://giscus.app/client.js';
    s.async = true;
    s.crossOrigin = 'anonymous';
    const attrs: Record<string, string> = {
      'data-repo': host.dataset.repo!,
      'data-repo-id': host.dataset.repoId!,
      'data-category': host.dataset.category!,
      'data-category-id': host.dataset.categoryId!,
      'data-mapping': 'specific',
      'data-term': host.dataset.giscusTerm!,
      'data-strict': '1',
      'data-reactions-enabled': '1',
      'data-emit-metadata': '0',
      'data-input-position': 'top',
      'data-theme': `${location.origin}/giscus.css`,
      'data-lang': 'en',
      'data-loading': 'lazy',
    };
    for (const [k, v] of Object.entries(attrs)) s.setAttribute(k, v);
    host.querySelector('.discussion__placeholder')?.remove();
    host.append(s);
  };
  const io = new IntersectionObserver(
    ([e]) => {
      if (!e.isIntersecting) return;
      io.disconnect();
      load();
    },
    { rootMargin: '600px' },
  );
  io.observe(host);
}
