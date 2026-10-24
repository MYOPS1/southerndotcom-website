import { createClient } from '@supabase/supabase-js';
import { createPayments } from './payments.js';

const PROJECT = 'https://uhuukcztdifvpjuopdea.supabase.co';

// Server-to-server webhook. No browser cookies or Origin: authenticity comes from the
// hash check plus independent gateway confirmation inside createPayments().callback.
export function createCallbackHandler({ env = process.env, clientFactory = createClient, transport = fetch } = {}) {
  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    const reply = (status, body) => res.status(status).json(body);
    if (env.VERCEL_ENV !== 'preview') return reply(404, { error: 'Preview-only.' });
    if (req.method !== 'POST') return reply(405, { error: 'Method not allowed.' });
    try {
      let fields = req.body;
      if (typeof fields === 'string') {
        if (fields.length > 4000) return reply(400, { error: 'invalid' });
        fields = Object.fromEntries(new URLSearchParams(fields));
      }
      if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return reply(400, { error: 'invalid' });
      const payments = createPayments({ env, transport, adminFactory: clientFactory, project: PROJECT });
      const result = await payments.callback(fields);
      return reply(result.status, result.body);
    } catch {
      return reply(500, { error: 'callback_failed' });
    }
  };
}
