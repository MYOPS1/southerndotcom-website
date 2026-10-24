import { useState } from 'react';
import PropTypes from 'prop-types';

const catalog = [
  { name: 'OpsPS', description: 'Personal shopper operations', art: 'opsps', status: 'preview' },
  { name: 'OpsFinance', description: 'Accounting & financial management', art: 'opsfinance', status: 'preview' },
  { name: 'OpsFlow', description: 'Workflow & business automation', art: 'opsflow', status: 'preview' },
  { name: 'OpsWMS', description: 'Warehouse management', art: 'opswms', status: 'coming_soon' },
  { name: 'OpsHR', description: 'Human resources management', art: 'opshr', status: 'coming_soon' },
];

function Notice() {
  return <div className="account-preview-notice" role="status"><strong>Design preview only.</strong> Registration, login, payments and app access are not active yet. No information entered here is sent or saved.</div>;
}

export function AccountPreview({ mode }) {
  const [accountType, setAccountType] = useState('personal');
  const title = mode === 'register' ? 'Create your MYOPS account' : mode === 'dashboard' ? 'Your MYOPS dashboard' : 'Welcome back to MYOPS';
  return (
    <section className="account-preview container" aria-labelledby="account-preview-title">
      <div className="account-preview-heading">
        <span className="account-eyebrow">MYOPS · Customer Portal</span>
        <h1 id="account-preview-title">{title}</h1>
        <p>One secure MYOPS login. Open only the applications included in your active subscription.</p>
      </div>
      <Notice />
      {mode === 'dashboard' ? (
        <>
          <div className="account-preview-panel">
            <h2>My subscriptions</h2>
            <p>After login, your active products, renewal preferences and invoices will appear here. Access will be verified by the server.</p>
            <div className="account-preview-stats">
              <span><strong>Personal / Business</strong><small>Account types</small></span>
              <span><strong>Manual / Auto</strong><small>Renewal options</small></span>
              <span><strong>15 minutes</strong><small>Inactivity timeout</small></span>
            </div>
          </div>
          <div className="account-preview-catalog">
            {catalog.map((item) => (
              <article className="account-app-card" key={item.name}>
                <img src={`/images/${item.art}-card-art.png`} alt="" loading="lazy" />
                <h3>{item.name}</h3>
                <p>{item.description}</p>
                <span className="account-app-state">{item.status === 'coming_soon' ? 'Coming Soon' : 'Access available after launch & subscription'}</span>
                <button type="button" disabled>{item.status === 'coming_soon' ? 'Coming Soon' : 'Open App (Not Active)'}</button>
              </article>
            ))}
          </div>
        </>
      ) : (
        <div className="account-preview-panel account-form-panel">
          {mode === 'register' && (
            <fieldset className="account-type-picker">
              <legend>Choose account type</legend>
              <label><input type="radio" name="account-type" checked={accountType === 'personal'} onChange={() => setAccountType('personal')} /> Personal</label>
              <label><input type="radio" name="account-type" checked={accountType === 'business'} onChange={() => setAccountType('business')} /> Business</label>
            </fieldset>
          )}
          <form onSubmit={(event) => event.preventDefault()}>
            {mode === 'register' && (
              <label>{accountType === 'business' ? 'Company name' : 'Full name'}<input type="text" placeholder={accountType === 'business' ? 'Your company' : 'Your name'} autoComplete="off" disabled /></label>
            )}
            <label>Email address<input type="email" placeholder="name@example.com" autoComplete="off" disabled /></label>
            <label>Password<input type="password" placeholder="••••••••" autoComplete="off" disabled /></label>
            <button type="button" className="btn btn-primary" disabled>{mode === 'register' ? 'Create account (Coming Soon)' : 'Sign in (Coming Soon)'}</button>
          </form>
          <p className="account-switch">{mode === 'register' ? 'Already have an account?' : 'New to MYOPS?'} <a href={mode === 'register' ? '/login' : '/register'}>{mode === 'register' ? 'Sign in preview' : 'Register preview'}</a></p>
          <a href="/account" className="account-dashboard-link">View customer dashboard preview →</a>
        </div>
      )}
    </section>
  );
}

AccountPreview.propTypes = { mode: PropTypes.oneOf(['login', 'register', 'dashboard']).isRequired };
