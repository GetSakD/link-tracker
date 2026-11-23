/* morph(): update a container to match new HTML by changing only what differs.
   Buttons you're pressing, focus, scroll position and running CSS animations all survive a refresh,
   which is what lets the panel update every few seconds without ever eating a tap. */
const keyOf = n => n.nodeType === 1 ? (n.getAttribute('data-key') || n.id || null) : null;
const same = (a, b) => a.nodeType === b.nodeType && a.nodeName === b.nodeName && keyOf(a) === keyOf(b);

function patchAttrs(el, to) {
  for (const { name } of [...el.attributes]) if (!to.hasAttribute(name)) el.removeAttribute(name);
  for (const { name, value } of [...to.attributes]) if (el.getAttribute(name) !== value) el.setAttribute(name, value);
  if (el.nodeName === 'DETAILS') el.open = to.hasAttribute('open');
}

function patch(el, to) {
  if (el.nodeType === 3 || el.nodeType === 8) { if (el.nodeValue !== to.nodeValue) el.nodeValue = to.nodeValue; return; }
  // countdowns are updated in place by the ticker; only rebuild one when its shown value really changed
  const liveSame = el.hasAttribute('data-live') && el.getAttribute('data-v') === to.getAttribute('data-v');
  patchAttrs(el, to);
  if (el.nodeName === 'INPUT' || el.nodeName === 'TEXTAREA' || liveSame) return;   // never touch what someone is typing
  patchChildren(el, to);
}

function patchChildren(el, to) {
  const next = [...to.childNodes];
  let cur = el.firstChild;
  for (const n of next) {
    // look ahead a little for a match, so inserting one row doesn't rebuild the rest
    let m = cur, steps = 0;
    while (m && !same(m, n) && steps < 4) { m = m.nextSibling; steps++; }
    if (m && same(m, n)) {
      while (cur !== m) { const gone = cur; cur = cur.nextSibling; gone.remove(); }
      patch(m, n);
      cur = m.nextSibling;
    } else el.insertBefore(n, cur);
  }
  while (cur) { const gone = cur; cur = cur.nextSibling; gone.remove(); }
}

export function morph(container, html) {
  if (container._html === html) return false;
  container._html = html;
  const t = document.createElement('template');
  t.innerHTML = html;
  patchChildren(container, t.content);
  return true;
}
