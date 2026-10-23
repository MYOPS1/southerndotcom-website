import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { importSrc } from './helpers/load-src.mjs';

const { SessionProvider, ProductAction } = await importSrc('session.jsx');
const { FoundersPromo } = await importSrc('FoundersPromo.jsx');

const states = { opsp: 'none', opsfinance: 'none', opsflow: 'none', opswms: 'coming_soon', opshr: 'coming_soon' };
const active = { ...states, opsp: 'active', opsfinance: 'active', opsflow: 'active' };
const signedIn = (extra) => ({ signedIn: true, email: 'u@example.test', products: states, lifetime: false, ...extra });

async function mount(respond) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'https://trusted-preview.vercel.app/' });
  const originals = Object.fromEntries(['window', 'document', 'fetch', 'IS_REACT_ACT_ENVIRONMENT'].map((key) => [key, globalThis[key]]));
  const calls = [];
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    return respond(body);
  };
  const root = createRoot(document.getElementById('root'));
  await act(async () => root.render(createElement(SessionProvider, { enabled: true }, createElement('div', null,
    createElement(FoundersPromo), createElement('article', { id: 'opsp' }, createElement(ProductAction, { product: { slug: 'opsp' } }))))));
  return { calls, cleanup: async () => { await act(async () => root.unmount()); Object.assign(globalThis, originals); dom.window.close(); } };
}
const buttons = () => [...document.querySelectorAll('#founders a, #founders button:not([disabled])')].map((node) => node.textContent);
const founders = (remaining) => ({ capacity: 100, allocated: 100 - remaining, remaining, available: remaining > 0 });

test('signed-out visitors see the promotion with the server slot count and Register/Login', async () => {
  const { cleanup } = await mount((body) => Response.json(body.action === 'founders' ? founders(63) : { signedIn: false }));
  try {
    assert.match(document.querySelector('#founders').textContent, /Choose your MYOPS plan/);
    assert.equal(document.querySelector('.founders-count strong').textContent, '63');
    assert.match(document.querySelector('.founders-count').textContent, /of 100/);
    assert.deepEqual(buttons().slice(0, 2), ['Register to claim', 'Login']);
    assert.match(document.querySelector('#founders').textContent, /Sandbox/);
  } finally { await cleanup(); }
});

test('signed-in customers can claim; checkout is requested server-side for the founders plan', async () => {
  const { cleanup, calls } = await mount((body) => Response.json(body.action === 'founders' ? founders(5) : signedIn()));
  try {
    assert.equal(buttons()[0], 'Claim lifetime access — RM29 once');
    assert.equal(document.querySelector('#opsp a').getAttribute('href'), '/#founders');
    await act(async () => { document.querySelector('#founders button').click(); });
    assert.deepEqual(calls.find((c) => c.action === 'checkout'), { action: 'checkout', plan: 'founders_lifetime' });
  } finally { await cleanup(); }
});

test('sold-out founders never fall back to an obsolete single-app checkout', async () => {
  const { cleanup, calls } = await mount((body) => Response.json(body.action === 'founders' ? founders(0) : signedIn()));
  try {
    assert.equal(document.querySelector('.founders-count strong').textContent, '0');
    assert.match(document.querySelector('#founders').textContent, /All Founders 100 places are taken/);
    assert.equal(document.querySelector('#founders select'), null);
    assert.deepEqual(buttons(), []);
    assert.equal(calls.filter((c) => c.action === 'checkout').length, 0);
  } finally { await cleanup(); }
});

test('pricing has exactly Founders 100, 2 Apps and All Apps; monthly purchases remain paused', async () => {
  const { cleanup, calls } = await mount((body) => Response.json(body.action === 'founders' ? founders(5) : { signedIn: false }));
  try {
    const cards = [...document.querySelectorAll('.pricing-cards .price-card')];
    assert.deepEqual(cards.map((card) => card.querySelector('h3').textContent), ['Founders 100', '2 Apps', 'All Apps']);
    assert.deepEqual(cards.map((card) => card.querySelector('.price-amount').textContent), ['RM29 one-time', 'RM49 / month', 'RM79 / month']);
    assert.doesNotMatch(document.querySelector('#founders').textContent, /Single App|Business Basic|Business Pro|Enterprise|pending owner approval/);
    const monthly = [...document.querySelectorAll('.pricing-cards button')];
    assert.equal(monthly.length, 2);
    assert.ok(monthly.every((button) => button.disabled));
    monthly.forEach((button) => button.click());
    assert.equal(calls.filter((c) => c.action === 'checkout').length, 0);
  } finally { await cleanup(); }
});

test('server refusals are shown to the customer and the count is refreshed', async () => {
  const { cleanup, calls } = await mount((body) => {
    if (body.action === 'founders') return Response.json(founders(5));
    if (body.action === 'checkout') return Response.json({ error: 'All Founders 100 places are taken.' }, { status: 409 });
    return Response.json(signedIn());
  });
  try {
    await act(async () => { document.querySelector('#founders button').click(); });
    assert.equal(document.querySelector('.founders-error').textContent, 'All Founders 100 places are taken.');
    assert.equal(calls.filter((c) => c.action === 'founders').length, 2);
  } finally { await cleanup(); }
});

test('verified lifetime customers see Open App on the card and no purchase buttons', async () => {
  const { cleanup } = await mount((body) => Response.json(body.action === 'founders' ? founders(5) : signedIn({ lifetime: true, products: active })));
  try {
    assert.match(document.querySelector('#founders').textContent, /lifetime access is active/);
    assert.deepEqual(buttons(), []);
    assert.equal(document.querySelector('#opsp button').textContent, 'Open App');
  } finally { await cleanup(); }
});

test('unconfigured checkout shows no invented slot numbers and no purchase button', async () => {
  const { cleanup } = await mount((body) => Response.json(body.action === 'founders' ? { available: false } : signedIn()));
  try {
    assert.equal(document.querySelector('.founders-count'), null);
    assert.deepEqual(buttons(), []);
    assert.match(document.querySelector('#founders').textContent, /not available right now/);
  } finally { await cleanup(); }
});
