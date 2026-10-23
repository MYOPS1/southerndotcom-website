import React from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

const modules = [
  { id: 'finance', name: 'OpsFinance', icon: '◈', description: 'Accounting, invoices and financial reporting', state: 'Coming soon' },
  { id: 'flow', name: 'OpsFlow', icon: '▤', description: 'Inventory, orders and warehouse workflows', state: 'Coming soon' },
  { id: 'ps', name: 'OpsPS', icon: '◉', description: 'Personal shopper operations', state: 'Coming soon' },
  { id: 'hub', name: 'OpsHub', icon: '◇', description: 'Marketplace and community', state: 'Free module · Coming soon' },
];
function App() {
  return <div className="shell">
    <aside><div className="brand"><span className="logo">M</span><span>MYOPS <small>WORKSPACE</small></span></div><nav aria-label="Workspace"><a className="active" href="#dashboard">⌂ &nbsp; Dashboard</a><a href="#applications">▦ &nbsp; Applications</a><a href="#account">◯ &nbsp; Account</a></nav><div className="sidebarNote">Prototype · No account or payments connected</div></aside>
    <main id="dashboard"><header><div><div className="eyebrow">MYOPS PLATFORM</div><h1>Your workspace</h1><p>Manage your business tools in one place.</p></div><span className="avatar" aria-label="Demo account">DEMO</span></header>
    <section className="intro"><div><span className="pill">Workspace preview</span><h2>Everything you need to run your operations.</h2><p>One dashboard for OpsFinance, OpsFlow, OpsPS and OpsHub. Secure single sign-on and app access will be added later.</p></div><div className="mark">M<span>+</span></div></section>
    <section id="applications"><div className="sectionTitle"><h2>Applications</h2><span>4 modules</span></div><div className="cards">{modules.map(m=><article className="card" key={m.id}><div className={'appIcon '+m.id}>{m.icon}</div><h3>{m.name}</h3><p>{m.description}</p><div className="bottom"><span className="status">{m.state}</span><button type="button" disabled title="Not connected yet">Open app →</button></div></article>)}</div></section>
    <section className="account" id="account"><h2>Account & subscription</h2><p>Authentication, plan status and entitlements are not connected. This preview does not collect credentials or process payments.</p></section>
    <footer>MYOPS Workspace · Development preview</footer></main>
  </div>;
}
createRoot(document.getElementById('root')).render(<App/>);
