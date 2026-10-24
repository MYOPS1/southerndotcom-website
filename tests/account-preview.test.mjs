import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
const preview = readFileSync(new URL('../src/AccountPreview.jsx', import.meta.url), 'utf8');
const schema = readFileSync(new URL('../supabase/migrations/202610160001_myops_identity_foundation.sql', import.meta.url), 'utf8');

test('account preview routes exist', () => {
  for (const route of ['/login', '/register', '/account']) {
    assert.ok(app.includes(`'${route}':`), `missing ${route}`);
  }
});

test('login and checkout are not misrepresented as working', () => {
  assert.match(preview, /Design preview only/);
  assert.match(preview, /Sign in \(Coming Soon\)/);
  assert.match(preview, /Create account \(Coming Soon\)/);
  assert.match(preview, /disabled>/);
});

test('all five products are shown, with upcoming apps locked', () => {
  for (const product of ['OpsPS', 'OpsFinance', 'OpsFlow', 'OpsWMS', 'OpsHR']) {
    assert.ok(preview.includes(`name: '${product}'`));
  }
  assert.match(preview, /status: 'coming_soon'/);
  assert.match(preview, /Open App \(Not Active\)/);
});

test('schema enables RLS on all account and billing tables', () => {
  for (const table of ['myops_profiles', 'myops_organizations', 'myops_memberships', 'myops_products', 'myops_subscriptions', 'myops_app_grants', 'myops_app_sessions']) {
    assert.ok(schema.includes(`alter table public.${table} enable row level security;`), `RLS missing for ${table}`);
  }
});

test('session and renewal preferences have explicit fields', () => {
  assert.match(schema, /last_activity_at timestamptz/);
  assert.match(schema, /renewal_mode text not null default 'manual'/);
});
