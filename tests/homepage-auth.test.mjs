import test from 'node:test';
import assert from 'node:assert/strict';
import { importSrc } from './helpers/load-src.mjs';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';

const { SessionProvider, AuthNav, ProductAction, useSession } = await importSrc('session.jsx');

const products = [{ slug: 'opsp' }, { slug: 'opsfinance' }, { slug: 'opsflow' }, { slug: 'opswms', comingSoon: true }];
const signedOut = { signedIn: false };
const signedInState = (states) => ({ signedIn: true, email: 'user@example.test', products: {
  opsp: 'active', opsfinance: 'none', opsflow: 'coming_soon', opswms: 'coming_soon', opshr: 'coming_soon', ...states } });

function Refresher() {
  const { refresh } = useSession();
  return createElement('button', { id: 'passive', onClick: () => refresh(false) }, 'probe');
}
function Page({ enabled = true }) {
  return createElement(SessionProvider, { enabled }, createElement('div', null,
    createElement(AuthNav), createElement(Refresher),
    ...products.map((product) => createElement('article', { key: product.slug, id: product.slug },
      createElement(ProductAction, { product })))));
}

async function mount(respond, enabled = true) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'https://trusted-preview.vercel.app/' });
  const originals = Object.fromEntries(['window', 'document', 'Element', 'HTMLElement', 'fetch', 'IS_REACT_ACT_ENVIRONMENT'].map((key) => [key, globalThis[key]]));
  const calls = [];
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    Element: dom.window.Element,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    return respond(body);
  };
  const root = createRoot(document.getElementById('root'));
  await act(async () => root.render(createElement(Page, { enabled })));
  const cleanup = async () => {
    await act(async () => root.unmount());
    Object.assign(globalThis, originals);
    dom.window.close();
  };
  return { calls, cleanup, dom };
}
const text = (selector) => document.querySelector(selector)?.textContent ?? '';
const nav = () => [...document.querySelectorAll('.nav-auth a, .nav-auth button')].map((node) => node.textContent);

test('signed-out visitors see Register and Login, and Subscribe on live cards', async () => {
  const { cleanup } = await mount(() => Response.json(signedOut));
  try {
    assert.deepEqual(nav(), ['Register', 'Login']);
    assert.equal(document.querySelector('.nav-auth a[href="/register"]').textContent, 'Register');
    assert.equal(document.querySelector('.nav-auth a[href="/login"]').textContent, 'Login');
    for (const slug of ['opsp', 'opsfinance', 'opsflow']) {
      assert.equal(text(`#${slug} .product-action`), 'Subscribe');
      assert.equal(document.querySelector(`#${slug} a`).getAttribute('href'), '/login');
      assert.equal(document.querySelector(`#${slug} button`), null);
    }
    assert.equal(document.querySelector('#opswms').textContent, '');
  } finally { await cleanup(); }
});

test('signed-in users see My Account and Logout instead of Register and Login', async () => {
  const { cleanup } = await mount(() => Response.json(signedInState()));
  try {
    assert.deepEqual(nav(), ['My Account', 'Logout']);
    assert.equal(document.querySelector('.nav-auth a').getAttribute('href'), '/account');
    assert.ok(!nav().includes('Register') && !nav().includes('Login'));
  } finally { await cleanup(); }
});

test('signed-in subscribe links open the founders offer section instead of doing nothing', async () => {
  const { cleanup, dom } = await mount(() => Response.json(signedInState()));
  const original = Element.prototype.scrollIntoView;
  let scrolled = false;
  Element.prototype.scrollIntoView = function () { scrolled = true; };
  try {
    const link = document.querySelector('#opsfinance a');
    assert.equal(link.getAttribute('href'), '/#founders');
    await act(async () => link.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true })));
    assert.ok(scrolled || dom.window.location.hash === '#founders');
  } finally {
    Element.prototype.scrollIntoView = original;
    await cleanup();
  }
});

test('product cards reflect Active, No subscription and Coming Soon states from the server', async () => {
  const { cleanup } = await mount(() => Response.json(signedInState({ opsflow: 'coming_soon' })));
  try {
    assert.equal(text('#opsp .product-action button'), 'Open App');
    assert.equal(text('#opsfinance .product-action'), 'Subscribe');
    assert.equal(document.querySelector('#opsfinance a').getAttribute('href'), '/#founders');
    assert.equal(text('#opsflow .coming-soon-label'), 'Coming Soon');
    assert.equal(document.querySelector('#opsflow button'), null);
  } finally { await cleanup(); }
});

test('Open App asks the server and shows the denial; frontend state never unlocks access', async () => {
  const { calls, cleanup, dom } = await mount((body) => body.action === 'launch'
    ? Response.json({ error: 'An active subscription is required for this application.' }, { status: 403 })
    : Response.json(signedInState()));
  try {
    await act(async () => document.querySelector('#opsp button').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
    assert.deepEqual(calls.at(-1), { action: 'launch', product: 'opsp' });
    assert.match(text('#opsp [role=status]'), /active subscription is required/);
    assert.equal(dom.window.location.href, 'https://trusted-preview.vercel.app/');
  } finally { await cleanup(); }
});

test('a passive probe after server-side inactivity logout returns the nav to signed-out', async () => {
  let signedIn = true;
  const { calls, cleanup, dom } = await mount(() => Response.json(signedIn ? signedInState() : signedOut));
  try {
    assert.deepEqual(nav(), ['My Account', 'Logout']);
    signedIn = false;
    await act(async () => document.querySelector('#passive').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
    assert.deepEqual(calls.at(-1), { action: 'session', activity: false });
    assert.deepEqual(nav(), ['Register', 'Login']);
    assert.equal(text('#opsp .product-action'), 'Subscribe');
  } finally { await cleanup(); }
});

test('network or server failure shows signed-out state, never an unlocked app', async () => {
  const { cleanup } = await mount(() => { throw new TypeError('Failed to fetch'); });
  try {
    assert.deepEqual(nav(), ['Register', 'Login']);
    assert.equal(document.querySelector('.product-action button'), null);
  } finally { await cleanup(); }
});

test('outside Preview auth builds no auth controls and no requests are made', async () => {
  const { calls, cleanup } = await mount(() => Response.json(signedInState()), false);
  try {
    assert.equal(calls.length, 0);
    assert.equal(document.querySelector('.nav-auth'), null);
    assert.equal(document.querySelector('.product-action'), null);
  } finally { await cleanup(); }
});

test('logout failure stays visible and retryable, including after a signed-out probe', async () => {
  let signedIn = true;
  let finishLogout;
  const { calls, cleanup, dom } = await mount((body) => body.action === 'logout'
    ? new Promise((resolve) => { finishLogout = resolve; })
    : Response.json(signedIn ? signedInState() : signedOut));
  const click = (selector) => document.querySelector(selector).dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  try {
    await act(async () => { click('.nav-auth button'); click('.nav-auth button'); });
    assert.equal(calls.filter((body) => body.action === 'logout').length, 1);
    assert.equal(document.querySelector('.nav-auth button').disabled, true);
    await act(async () => finishLogout(Response.json({ error: 'Session revocation unavailable.' }, { status: 503 })));
    assert.match(text('[role=alert]'), /Sign out could not be confirmed/);
    assert.equal(document.querySelector('.nav-auth button').disabled, false);
    signedIn = false;
    await act(async () => click('#passive'));
    assert.equal(text('.nav-auth button'), 'Logout');
    assert.equal(document.querySelector('#opsp button'), null);
    await act(async () => click('.nav-auth button'));
    assert.equal(calls.filter((body) => body.action === 'logout').length, 2);
    await act(async () => finishLogout(Response.json({ error: 'Retry later.' }, { status: 503 })));
    assert.match(text('[role=alert]'), /Retry later/);
    assert.equal(dom.window.location.href, 'https://trusted-preview.vercel.app/');
  } finally { await cleanup(); }
});
