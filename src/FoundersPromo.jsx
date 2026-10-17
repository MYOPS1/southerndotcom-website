import { useCallback, useEffect, useRef, useState } from 'react';
import { authRequest } from './authRequest';
import { useSession } from './session';

const POLL_MS = 3000;
const POLL_MAX = 10;

// Display only. Slot counts come from the server and access is re-checked server-side.
export function FoundersPromo() {
  const session = useSession();
  const [founders, setFounders] = useState(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState(false);
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

  async function start(plan) {
    if (busy) return;
    setBusy(true); setMessage('');
    try {
      const result = await authRequest('checkout', { plan });
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
    action = <button type="button" className="btn btn-primary" disabled={busy} onClick={() => start('all_apps_monthly')}>Subscribe — RM29/month</button>;
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
        <p>The first 100 paying Individual customers get all current and future MYOPS applications for a single RM29 payment. From customer 101 the All Apps Bundle is RM29/month.</p>
        {founders?.available !== undefined && founders.remaining !== undefined && (
          <p className="founders-count" aria-live="polite">
            <strong>{founders.remaining}</strong> of {founders.capacity} Founder places remaining
          </p>
        )}
        {action}
        {waiting && <p role="status">Confirming your payment…</p>}
        <p role="status" className="founders-error">{message}</p>
        <p className="founders-note">Sandbox payments only: no real money is charged in Preview.</p>
      </div>
    </section>
  );
}
