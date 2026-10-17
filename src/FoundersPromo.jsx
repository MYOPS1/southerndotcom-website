import { useCallback, useEffect, useRef, useState } from 'react';
import { authRequest } from './authRequest';
import { useSession } from './session';

const POLL_MS = 3000;
const POLL_MAX = 10;
const LABELS = { opsp: 'OpsPS', opsfinance: 'OpsFinance', opsflow: 'OpsFlow', opswms: 'OpsWMS', opshr: 'OpsHR' };
// Proposed pricing is shown for transparency only; the server and database keep it disabled.
const PROPOSED = [
  { name: 'Two-app bundle', price: 'RM49/month', note: 'Any two apps' },
  { name: 'All-app bundle', price: 'RM79/month', note: 'Every live app' },
  { name: 'Business Basic', price: 'Pricing to be confirmed', note: 'Up to 5 users' },
  { name: 'Business Pro', price: 'Pricing to be confirmed', note: 'Up to 20 users' },
  { name: 'Enterprise', price: 'Custom', note: 'Contact us' },
];

// Display only. Slot counts come from the server and access is re-checked server-side.
export function FoundersPromo() {
  const session = useSession();
  const [founders, setFounders] = useState(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [app, setApp] = useState('');
  const polls = useRef(0);

  const loadFounders = useCallback(() => authRequest('founders').then(setFounders).catch(() => setFounders({ available: false })), []);
  useEffect(() => { if (session.enabled) loadFounders(); }, [session.enabled, loadFounders]);

  const returning = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('payment') === 'return';
  useEffect(() => {
    if (!session.enabled || !returning || !session.signedIn || session.lifetime) { setWaiting(false); return undefined; }
    setWaiting(true);
    const timer = setInterval(() => {
      polls.current += 1;
      session.refresh(false);
      if (polls.current >= POLL_MAX) { clearInterval(timer); setWaiting(false); }
    }, POLL_MS);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.enabled, session.signedIn, session.lifetime, returning]);

  if (!session.enabled || session.status === 'loading') return null;

  async function start(plan, product) {
    if (busy) return;
    setBusy(true); setMessage('');
    try {
      const result = await authRequest('checkout', product ? { plan, product } : { plan });
      window.location.assign(result.next);
    } catch (error) {
      setMessage(error.message);
      if (error.status === 401) session.refresh(false);
      loadFounders();
    } finally { setBusy(false); }
  }

  const soldOut = founders && founders.available === false && founders.remaining === 0;
  let action;
  if (session.signedIn && session.lifetime) {
    action = <p className="founders-note" role="status">Your Founders 100 lifetime access is active. Open any app from the cards below.</p>;
  } else if (!session.signedIn) {
    action = (
      <div className="founders-actions">
        <a className="btn btn-primary" href="/register">Register to claim</a>
        <a className="btn btn-secondary" href="/login">Login</a>
      </div>
    );
  } else if (soldOut) {
    const choices = Object.entries(session.products || {}).filter(([, state]) => state === 'none').map(([slug]) => slug);
    action = choices.length ? (
      <div className="founders-actions">
        <label>
          Choose one app{' '}
          <select value={app || choices[0]} onChange={(event) => setApp(event.target.value)}>
            {choices.map((slug) => <option key={slug} value={slug}>{LABELS[slug] || slug}</option>)}
          </select>
        </label>
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => start('single_app_monthly', choices.includes(app) ? app : choices[0])}>Subscribe — RM29/month</button>
      </div>
    ) : <p className="founders-note">You already have access to every available app.</p>;
  } else if (founders?.available) {
    action = <button type="button" className="btn btn-primary" disabled={busy} onClick={() => start('founders_lifetime')}>Claim lifetime access — RM29 once</button>;
  } else {
    action = <p className="founders-note">Checkout is not available right now.</p>;
  }

  return (
    <section className="content-section founders-promo" id="founders" aria-labelledby="founders-title">
      <div className="container founders-card">
        <p className="section-label">Founders 100</p>
        <h2 id="founders-title">RM29 once for lifetime access to every MYOPS app</h2>
        <p>The first 100 paying Individual customers get all current and future MYOPS applications for a single RM29 payment. After the 100 Founder places are taken, RM29/month covers one selected app.</p>
        {soldOut && <p>All Founders 100 places are taken. Subscribe to one app for RM29/month.</p>}
        {founders?.available !== undefined && founders.remaining !== undefined && (
          <p className="founders-count" aria-live="polite">
            <strong>{founders.remaining}</strong> of {founders.capacity} Founder places remaining
          </p>
        )}
        {action}
        {waiting && <p role="status">Confirming your payment…</p>}
        <p role="status" className="founders-error">{message}</p>
        <ul className="founders-proposed" aria-label="Proposed plans, not yet available">
          {PROPOSED.map((plan) => (
            <li key={plan.name}>
              <strong>{plan.name}</strong> — {plan.price} · {plan.note}
              <button type="button" className="btn btn-secondary" disabled>Not yet available</button>
            </li>
          ))}
        </ul>
        <p className="founders-note">Proposed plans are pending owner approval and cannot be purchased.</p>
        <p className="founders-note">Sandbox payments only: no real money is charged in Preview.</p>
      </div>
    </section>
  );
}
