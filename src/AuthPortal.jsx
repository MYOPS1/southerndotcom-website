import { useEffect, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import { authRequest as request } from './authRequest';

const productLabels = { opsp: 'OpsPS', opsfinance: 'OpsFinance', opsflow: 'OpsFlow', opswms: 'OpsWMS', opshr: 'OpsHR' };

export function AuthPortal({ mode }) {
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [account, setAccount] = useState(null);
  const [accountType, setAccountType] = useState('personal');
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (mode === 'callback') {
      const params = new URLSearchParams(window.location.search);
      const code = params.get('code');
      // Remove sensitive callback material before any request/navigation. No tokens
      // are handled by browser code, including implicit-flow fragments.
      window.history.replaceState(null, '', '/auth/callback');
      if (!code || params.has('error')) { setMessage('Invalid or expired link. Request a new email.'); return; }
      setBusy(true);
      request('callback', { code }).then((data) => window.location.replace(data.next))
        .catch((error) => setMessage(error.message)).finally(() => setBusy(false));
    } else if (mode === 'dashboard' || mode === 'reset') {
      setBusy(true);
      request('account').then(setAccount).catch((error) => {
        if (error.status === 401) window.location.replace('/login');
        else setMessage(error.message);
      }).finally(() => setBusy(false));
    }
  }, [mode]);

  async function submit(event) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setMessage('');
    try {
      const fields = Object.fromEntries(new FormData(event.currentTarget));
      const action = mode === 'dashboard' ? 'profile' : mode;
      const result = await request(action, fields);
      if (result.next) window.location.assign(result.next);
      else setMessage(result.message);
    } catch (error) { setMessage(error.message); }
    finally { setBusy(false); }
  }

  async function logout() {
    setBusy(true);
    try { const result = await request('logout'); window.location.replace(result.next); }
    catch (error) { setMessage(error.message); setBusy(false); }
  }

  const titles = { register: 'Create your MYOPS account', login: 'Welcome back to MYOPS',
    forgot: 'Reset your password', reset: 'Choose a new password', callback: 'Confirming your MYOPS account', dashboard: 'Your MYOPS account' };
  return (
    <section className="account-preview container" aria-labelledby="auth-title">
      <div className="account-preview-heading"><span className="account-eyebrow">MYOPS · Customer Portal</span>
        <h1 id="auth-title">{titles[mode]}</h1>
        <p>Secure MYOPS account access · Development Preview</p>
      </div>
      <div className="account-preview-panel account-form-panel">
        <p role="status" aria-live="polite">{busy ? 'Please wait…' : message}</p>
        {mode === 'dashboard' && account && <>
          <p>Signed in as {account.email}</p>
          {account.profile && <p>{account.profile.display_name} · {account.profile.account_type === 'business' ? 'Business' : 'Personal'}</p>}
          <p>Open applications from the <a href="/">MYOPS homepage</a>; access is checked by the server on every launch.</p>
          {account.profile?.account_type === 'business' && <p>Business workspace setup, seats and invitations are not enabled yet.</p>}
          <section id="subscription" aria-labelledby="subscription-title">
            <h2 id="subscription-title">Billing and subscriptions</h2>
            {account.products ? (
              <ul>
                {Object.entries(productLabels).map(([slug, label]) => (
                  <li id={`subscription-${slug}`} key={slug}>
                    {label}: {({ active: 'Active subscription', none: 'No subscription', coming_soon: 'Coming soon' })[account.products[slug]]}
                    {account.products[slug] === 'none' && <> — <a className="btn btn-secondary" href="/#founders">View Founders 100 and All Apps offer</a></>}
                  </li>
                ))}
              </ul>
            ) : <p>Subscription status is currently unavailable.</p>}
            {account.lifetime && <p>Founders 100 lifetime access: active (all current and future MYOPS apps).</p>}
            <p>Preview payments use the ToyyibPay sandbox only. Application access is granted only after the server confirms a verified payment or active subscription.</p>
          </section>
          <p>Cross-app SSO is not enabled. This site signs you out after 15 minutes of inactivity.</p>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={logout}>Sign out</button>
          <p><a href="/forgot-password">Change password</a></p>
        </>}
        {mode === 'callback' && <p><a href="/login">Return to sign in</a></p>}
        {mode !== 'callback' && (mode !== 'dashboard' || (account && !account.profile)) && (mode !== 'reset' || account) && (
          <form onSubmit={submit} aria-busy={busy}>
            {(mode === 'register' || mode === 'dashboard') && <>
              <h2>{mode === 'dashboard' ? 'Complete your profile' : 'Account details'}</h2>
              {mode === 'dashboard' && <p>Your name and account type are saved to your MYOPS account as descriptive details. Business workspaces, seats and invitations are not enabled.</p>}
              <label>Full name<input name="displayName" autoComplete="name" required maxLength={120} disabled={busy} /></label>
              <label>Account type<select name="accountType" value={accountType} onChange={(e) => setAccountType(e.target.value)} disabled={busy}>
                <option value="personal">Personal / Individual</option><option value="business">Business</option>
              </select></label>
            </>}
            {['register', 'login', 'forgot'].includes(mode) && <label>Email address<input name="email" type="email" autoComplete="email" required maxLength={254} disabled={busy} /></label>}
            {['register', 'login', 'reset'].includes(mode) && <label>Password<input name="password" type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} required minLength={mode === 'login' ? 1 : 12} maxLength={128} disabled={busy} /></label>}
            {mode === 'register' && <p>Use 12–128 characters for your password. Open the confirmation email in this same browser.</p>}
            <button className="btn btn-primary" type="submit" disabled={busy}>{busy ? 'Please wait…' : ({ register: 'Register', login: 'Sign in', forgot: 'Send recovery email', reset: 'Save password', dashboard: 'Save profile' })[mode]}</button>
          </form>
        )}
        <p className="account-switch"><a href="/login">Sign in</a> · <a href="/register">Register</a> · <a href="/forgot-password">Forgot password?</a></p>
      </div>
    </section>
  );
}
AuthPortal.propTypes = { mode: PropTypes.oneOf(['register', 'login', 'forgot', 'reset', 'callback', 'dashboard']).isRequired };
