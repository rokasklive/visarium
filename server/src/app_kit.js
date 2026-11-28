// Visarium's app kit, script half (canvas/apps; openspec canvas-apps-live §6).
// Served from the sandbox origin as /kit.js and linked at the top of every
// app view's <head>. It sends the board a snapshot of the page whenever the
// page settles, so the app's card shows what the app last drew. The board
// cleans it again and draws it as an image: nothing in it ever runs.
(() => {
  const SETTLE_MS = 400;
  const MAX = 64 * 1024;
  const URLISH = /^(src|href|xlink:href|srcset|action|formaction|poster|background)$/i;
  let timer = 0;
  let last = '';

  const snapshot = () => {
    const body = document.body;
    if (!body) return;
    // A <canvas> keeps its pixels only as an image.
    const pixels = [...document.querySelectorAll('canvas')].map((c) => {
      try {
        return c.toDataURL();
      } catch {
        return '';
      }
    });
    const clone = body.cloneNode(true);
    clone.querySelectorAll('canvas').forEach((c, i) => {
      const img = document.createElement('img');
      if (pixels[i]) img.setAttribute('src', pixels[i]);
      img.setAttribute('width', c.getAttribute('width') || String(c.width));
      img.setAttribute('height', c.getAttribute('height') || String(c.height));
      if (c.getAttribute('style')) img.setAttribute('style', c.getAttribute('style'));
      if (c.getAttribute('class')) img.setAttribute('class', c.getAttribute('class'));
      c.replaceWith(img);
    });
    // What a person typed shows as it is.
    const fields = [...body.querySelectorAll('input, textarea, select')];
    clone.querySelectorAll('input, textarea, select').forEach((f, i) => {
      const live = fields[i];
      if (!live) return;
      if (f.tagName === 'TEXTAREA') f.textContent = live.value;
      else if (f.tagName === 'SELECT') {
        for (const o of f.querySelectorAll('option')) o.toggleAttribute('selected', o.value === live.value);
      } else if (live.type === 'checkbox' || live.type === 'radio') f.toggleAttribute('checked', live.checked);
      else f.setAttribute('value', live.value);
    });
    clone.querySelectorAll('script, iframe, object, embed, link, meta, template, noscript').forEach((e) => {
      e.remove();
    });
    for (const el of clone.querySelectorAll('*')) {
      for (const a of [...el.attributes]) {
        if (/^on/i.test(a.name) || (URLISH.test(a.name) && !/^data:/i.test(a.value.trim()))) {
          el.removeAttribute(a.name);
        }
      }
    }
    // The app's own styles; the kit and the board's colours come back when it is drawn.
    const styles = [...document.querySelectorAll('style')]
      .filter((s) => !s.hasAttribute('data-visarium-kit'))
      .map((s) => s.textContent)
      .join('\n');
    const html = `<style>${styles}</style><div class="${body.className}">${clone.innerHTML}</div>`;
    if (html === last || html.length > MAX) return;
    last = html;
    parent.postMessage(
      {
        jsonrpc: '2.0',
        method: 'visarium/card',
        params: { html, width: innerWidth, height: innerHeight },
      },
      '*',
    );
  };

  const settle = () => {
    clearTimeout(timer);
    timer = setTimeout(snapshot, SETTLE_MS);
  };
  const watch = () =>
    document.fonts.ready.then(() => {
      new MutationObserver(settle).observe(document.documentElement, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true,
      });
      addEventListener('input', settle);
      settle();
    });
  if (document.readyState === 'complete') watch();
  else addEventListener('load', watch);
})();
