import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import PropTypes from 'prop-types';

const PROBE_INTERVAL_MS = 60 * 1000;
const SignedOut = { status: 'ready', signedIn: false, products: null };

async function authRequest(action, fields = {}) {
  let response;
  try {
    response = await fetch('/api/auth', {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, ...fields }),
    });
  } catch { throw new Error('Unable to connect. Check your connection and try again.'); }
  let result;
  try { result = await response.json(); }
  catch { throw new Error('Authentication service returned an unexpected response. Reload this Preview and try again.'); }
  if (!response.ok) {
    const error = new Error(result.error || 'Request failed.');
    error.status = response.status;
    throw error;
  }
  return result;
}

const SessionContext = createContext({ ...SignedOut, enabled: false, refresh: async () => {}, logout: async () => {} });

// Browser state is display-only. The server re-validates identity and subscriptions for every
// protected operation, so editing this state can never unlock an application.
export function SessionProvider({ enabled, children }) {
  const [state, setState] = useState(enabled ? { status: 'loading', signedIn: false, products: null } : SignedOut);
  const lastActivity = useRef(0);

  const refresh = useCallback(async (activity = true) => {
    if (!enabled) return;
    try {
      const result = await authRequest('session', { activity });
      setState(result.signedIn
        ? { status: 'ready', signedIn: true, email: result.email, products: result.products }
        : SignedOut);
    } catch {
      setState(SignedOut);
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return undefined;
    refresh(true);
    lastActivity.current = Date.now();
    // Passive probes reflect a server-side inactivity logout without extending the session.
    const timer = setInterval(() => refresh(false), PROBE_INTERVAL_MS);
    const onActivity = () => {
      if (Date.now() - lastActivity.current < PROBE_INTERVAL_MS) return;
      lastActivity.current = Date.now();
      refresh(true);
    };
    window.addEventListener('pointerdown', onActivity);
    window.addEventListener('keydown', onActivity);
    return () => {
      clearInterval(timer);
      window.removeEventListener('pointerdown', onActivity);
      window.removeEventListener('keydown', onActivity);
    };
  }, [enabled, refresh]);

  const logout = useCallback(async () => {
    try {
      const result = await authRequest('logout');
      window.location.replace(result.next);
    } catch {
      setState(SignedOut);
      window.location.replace('/');
    }
  }, []);

  const value = useMemo(() => ({ ...state, enabled, refresh, logout }), [state, enabled, refresh, logout]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
SessionProvider.propTypes = { enabled: PropTypes.bool.isRequired, children: PropTypes.node.isRequired };

// eslint-disable-next-line react-refresh/only-export-components
export function useSession() {
  return useContext(SessionContext);
}

export function AuthNav() {
  const session = useSession();
  if (!session.enabled || session.status === 'loading') return null;
  if (session.signedIn) {
    return (
      <div className="nav-auth">
        <a href="/account" className="btn btn-secondary">My Account</a>
        <button type="button" className="btn btn-primary" onClick={session.logout}>Logout</button>
      </div>
    );
  }
  return (
    <div className="nav-auth">
      <a href="/register" className="btn btn-secondary">Register</a>
      <a href="/login" className="btn btn-primary">Login</a>
    </div>
  );
}

export function ProductAction({ product }) {
  const session = useSession();
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  if (!session.enabled) return null;
  if (product.comingSoon) return null;

  const state = session.signedIn ? session.products?.[product.slug] : 'none';
  async function open() {
    if (busy) return;
    setBusy(true); setMessage('');
    try {
      const result = await authRequest('launch', { product: product.slug });
      window.location.assign(result.next);
    } catch (error) {
      setMessage(error.message);
      if (error.status === 401) session.refresh(false);
    } finally { setBusy(false); }
  }
  if (state === 'coming_soon') return <span className="coming-soon-label">Coming Soon</span>;
  if (state === 'active') {
    return (
      <div className="product-action">
        <button type="button" className="btn btn-primary" disabled={busy} onClick={open}>Open App</button>
        <p role="status" aria-live="polite">{message}</p>
      </div>
    );
  }
  return (
    <div className="product-action">
      <a className="btn btn-secondary" href={session.signedIn ? `/account#subscription-${product.slug}` : '/login'}>Subscribe</a>
    </div>
  );
}
ProductAction.propTypes = {
  product: PropTypes.shape({ slug: PropTypes.string.isRequired, comingSoon: PropTypes.bool }).isRequired,
};
