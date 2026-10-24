import { useEffect, useState } from 'react';
import PropTypes from 'prop-types';
import { authRequest } from './authRequest';

const short = (value) => (value ? `${String(value).slice(0, 8)}…` : '—');
const time = (value) => (value ? new Date(value).toISOString().replace('T', ' ').slice(0, 19) : '—');

function Table({ title, rows, columns }) {
  return (
    <section>
      <h2>{title} ({rows.length})</h2>
      <div className="audit-scroll">
        <table className="audit-table">
          <thead><tr>{columns.map(([label]) => <th key={label}>{label}</th>)}</tr></thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={row.order_ref || row.id || row.slot_number || index}>
                {columns.map(([label, render]) => <td key={label}>{render(row)}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

Table.propTypes = {
  title: PropTypes.string.isRequired,
  rows: PropTypes.arrayOf(PropTypes.object).isRequired,
  columns: PropTypes.arrayOf(PropTypes.array).isRequired,
};

// Read-only. The server rejects non-admins; hiding this page is not the control.
export function AdminAudit() {
  const [data, setData] = useState(null);
  const [message, setMessage] = useState('Loading…');
  useEffect(() => {
    authRequest('admin_audit').then((result) => { setData(result); setMessage(''); })
      .catch((error) => setMessage(error.status === 401 ? 'Sign in with an administrator account.' : error.message));
  }, []);
  return (
    <section className="content-section">
      <div className="container">
        <h1>Founders 100 audit</h1>
        {message && <p role="status">{message}</p>}
        {data && (
          <>
            <p>Allocated {data.founders.allocated} of {data.founders.capacity} · reserved {data.founders.reserved} · remaining {data.founders.remaining}</p>
            <Table title="Payments" rows={data.payments} columns={[
              ['Order', (r) => r.order_ref], ['User', (r) => short(r.user_id)], ['Plan', (r) => r.plan],
              ['Status', (r) => r.status], ['Outcome', (r) => r.outcome || '—'], ['Created', (r) => time(r.created_at)], ['Confirmed', (r) => time(r.confirmed_at)]]} />
            <Table title="Founder allocations" rows={data.allocations} columns={[
              ['Slot', (r) => r.slot_number], ['User', (r) => short(r.user_id)], ['Payment', (r) => short(r.payment_id)], ['Allocated', (r) => time(r.allocated_at)]]} />
            <Table title="Lifetime entitlements" rows={data.entitlements} columns={[
              ['User', (r) => short(r.user_id)], ['Scope', (r) => r.scope], ['Source', (r) => r.source], ['Status', (r) => r.status], ['Granted', (r) => time(r.granted_at)]]} />
            <Table title="Webhook events" rows={data.events} columns={[
              ['Order', (r) => r.order_ref], ['Verified outcome', (r) => r.verified_outcome], ['Result', (r) => r.result || '—'],
              ['Duplicates', (r) => r.duplicate_count], ['Last seen', (r) => time(r.last_seen_at)]]} />
          </>
        )}
      </div>
    </section>
  );
}
