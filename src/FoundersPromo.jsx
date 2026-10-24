import { useCallback, useEffect, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import { authRequest } from './authRequest';
import { useSession } from './session';

const POLL_MS = 3000;
const POLL_MAX = 10;
// Display only. Slot counts come from the server and access is re-checked server-side.
export function FoundersPromo({ production = false }) {
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
    action = <p className="founders-note" role="status">Your Founders 100 lifetime access is active. Open your apps from the MYOPS homepage.</p>;
  } else if (!session.signedIn) {
    action = (
      <div className="founders-actions">
        <a className="btn btn-primary" href="/register">Register to claim</a>
        <a className="btn btn-secondary" href="/login">Login</a>
      </div>
    );
  } else if (soldOut) {
    action = <p className="founders-note">All Founders 100 places are taken. Choose a monthly plan below when subscriptions open.</p>;
  } else if (founders?.available) {
    action = <button type="button" className="btn btn-primary" disabled={busy} onClick={() => start('founders_lifetime')}>Claim lifetime access — RM29 once</button>;
  } else {
    action = <p className="founders-note">Checkout is not available right now.</p>;
  }

  return (
    <section className="content-section founders-promo" id="founders" aria-labelledby="founders-title">
      <div className="container">
        <p className="section-label">Subscription &amp; Pricing</p>
        <h2 id="founders-title">Choose your MYOPS plan</h2>
        <div className="pricing-cards">
          <article className="price-card price-card-featured">
            <h3>Founders 100</h3>
            <p className="price-amount">RM29 <span>one-time</span></p>
            <p>Lifetime access to all current and future MYOPS apps. Limited to the first 100 successfully paying Individual customers.</p>
            {founders?.available !== undefined && founders.remaining !== undefined && (
              <p className="founders-count" aria-live="polite">
                <strong>{founders.remaining}</strong> of {founders.capacity} Founder places remaining
              </p>
            )}
            {action}
          </article>
          <article className="price-card">
            <h3>2 Apps</h3>
            <p className="price-amount">RM49 <span>/ month</span></p>
            <p>Choose any two available MYOPS apps. Renewed monthly.</p>
            <button type="button" className="btn btn-secondary" disabled>Subscriptions opening soon</button>
          </article>
          <article className="price-card">
            <h3>All Apps</h3>
            <p className="price-amount">RM79 <span>/ month</span></p>
            <p>Access every available MYOPS app. Renewed monthly.</p>
            <button type="button" className="btn btn-secondary" disabled>Subscriptions opening soon</button>
          </article>
        </div>
        {waiting && <p role="status">Confirming your payment…</p>}
        <p role="status" className="founders-error">{message}</p>
        <p className="founders-note">Monthly subscriptions are not open for purchase yet.</p>
        <p className="founders-note">{production ? 'Payments are not available yet.' : 'Sandbox payments only: no real money is charged in Preview. Payments are verified server-side before access is granted.'}</p>
      </div>
    </section>
  );
}

FoundersPromo.propTypes = { production: PropTypes.bool };
