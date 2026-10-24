import test from 'node:test';
import assert from 'node:assert/strict';
import { importSrc } from './helpers/load-src.mjs';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';

const { AuthPortal } = await importSrc('AuthPortal.jsx');

test('registration form submits fields, shows pending state, success and retryable failures', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'https://trusted-preview.vercel.app/register' });
  const originals = Object.fromEntries(['window', 'document', 'FormData', 'fetch', 'IS_REACT_ACT_ENVIRONMENT'].map((key) => [key, globalThis[key]]));
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, FormData: dom.window.FormData, IS_REACT_ACT_ENVIRONMENT: true });
  const root = createRoot(document.getElementById('root'));
  try {
    await act(async () => root.render(createElement(AuthPortal, { mode: 'register' })));
    document.querySelector('[name=displayName]').value = 'Preview Tester';
    document.querySelector('[name=email]').value = 'preview@example.test';
    document.querySelector('[name=password]').value = 'long-test-password';
    let resolveRequest;
    let sent;
    globalThis.fetch = async (url, init) => {
      sent = { url, ...init };
      return new Promise((resolve) => { resolveRequest = resolve; });
    };
    const submit = () => document.querySelector('form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await act(async () => submit());
    assert.equal(document.querySelector('button[type=submit]').disabled, true);
    assert.match(document.querySelector('[role=status]').textContent, /Please wait/);
    assert.equal(sent.url, '/api/auth');
    assert.deepEqual(JSON.parse(sent.body), { action: 'register', displayName: 'Preview Tester', accountType: 'personal', email: 'preview@example.test', password: 'long-test-password' });
    await act(async () => resolveRequest(Response.json({ message: 'Check your email in this browser.' })));
    assert.match(document.querySelector('[role=status]').textContent, /Check your email/);
    for (const response of [Response.json({ error: 'Preview authentication is not configured.' }, { status: 503 }), new Response('<html>unavailable</html>', { status: 502 })]) {
      globalThis.fetch = async () => response;
      await act(async () => submit());
      assert.match(document.querySelector('[role=status]').textContent, /not configured|unexpected response/);
      assert.equal(document.querySelector('button[type=submit]').disabled, false);
    }
    globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
    await act(async () => submit());
    assert.match(document.querySelector('[role=status]').textContent, /Check your connection/);
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, originals);
    dom.window.close();
  }
});
