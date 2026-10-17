import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

// Sandbox only. The host is a constant so live ToyyibPay cannot be reached by configuration.
const SANDBOX = 'https://dev.toyyibpay.com';
const PRICE_CENTS = 2900;
const PLANS = ['founders_lifetime', 'all_apps_monthly'];
const REF = /^MYOPS-[A-Za-z0-9_-]{8,64}$/;
const BILL = /^[A-Za-z0-9]{4,32}$/;
const SAFE_TEXT = /^[A-Za-z0-9._:@ -]{1,64}$/;

export const founderEventKey = ({ billcode, order_id: orderId, refno, status }) =>
  createHash('sha256').update([billcode, orderId, refno, status].join('|')).digest('hex');

const safeEqualHex = (a, b) => {
  const left = Buffer.from(String(a).toLowerCase());
  const right = Buffer.from(String(b).toLowerCase());
  return left.length === right.length && timingSafeEqual(left, right);
};

const toCents = (value) => {
  const text = String(value ?? '').trim();
  return /^\d{1,7}(\.\d{1,2})?$/.test(text) ? Math.round(Number(text) * 100) : null;
};

export function createPayments({ env, transport, adminFactory, project }) {
  const gatewayConfigured = () => Boolean(env.TOYYIBPAY_SANDBOX_SECRET_KEY && /^[A-Za-z0-9]{4,40}$/.test(env.TOYYIBPAY_SANDBOX_CATEGORY_CODE || ''));
  const adminKey = () => (typeof env.MYOPS_SERVICE_ROLE_KEY === 'string' && env.MYOPS_SERVICE_ROLE_KEY.startsWith('sb_secret_') ? env.MYOPS_SERVICE_ROLE_KEY : null);
  const admin = () => {
    const key = adminKey();
    return key ? adminFactory(project, key, { auth: { persistSession: false, autoRefreshToken: false } }) : null;
  };
  const rpc = async (client, name, args) => {
    const { data, error } = await client.rpc(name, args);
    if (error) throw new Error('rpc_failed');
    return data;
  };

  async function gatewayForm(path, fields) {
    const response = await transport(`${SANDBOX}/index.php/api/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(),
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error('gateway_http');
    return response.json();
  }

  async function createBill({ orderRef, origin }) {
    const result = await gatewayForm('createBill', {
      userSecretKey: env.TOYYIBPAY_SANDBOX_SECRET_KEY,
      categoryCode: env.TOYYIBPAY_SANDBOX_CATEGORY_CODE,
      billName: 'MYOPS All Apps',
      billDescription: 'MYOPS All Apps access (sandbox)',
      billPriceSetting: '1',
      billPayorInfo: '0',
      billAmount: String(PRICE_CENTS),
      billReturnUrl: `${origin}/?payment=return`,
      billCallbackUrl: `${origin}/api/toyyibpay-callback`,
      billExternalReferenceNo: orderRef,
      billTo: 'MYOPS customer',
      billEmail: 'sandbox@example.invalid',
      billPhone: '0000000000',
      billPaymentChannel: '2',
    });
    const code = Array.isArray(result) ? result[0]?.BillCode : null;
    if (typeof code !== 'string' || !BILL.test(code)) throw new Error('gateway_bill');
    return code;
  }

  // Independent server-to-server confirmation: a callback alone never grants anything.
  async function confirmPaid({ billCode, orderRef }) {
    const rows = await gatewayForm('getBillTransactions', {
      billCode, billpaymentStatus: '1',
    });
    if (!Array.isArray(rows)) throw new Error('gateway_shape');
    const row = rows.find((item) => item?.billExternalReferenceNo === orderRef && String(item?.billpaymentStatus) === '1');
    if (!row) return null;
    const cents = toCents(row.billpaymentAmount);
    const ref = typeof row.billpaymentInvoiceNo === 'string' && SAFE_TEXT.test(row.billpaymentInvoiceNo) ? row.billpaymentInvoiceNo : null;
    return { cents, ref };
  }

  async function founders() {
    const client = admin();
    if (!client) return { available: false };
    const status = await rpc(client, 'myops_founders_status', {});
    return { capacity: status.capacity, allocated: status.allocated, remaining: status.remaining, available: status.remaining > 0 };
  }

  async function checkout({ userId, plan, origin }) {
    const client = admin();
    if (!client || !gatewayConfigured()) return { status: 503, body: { error: 'Sandbox checkout is not configured for this Preview.' } };
    if (!PLANS.includes(plan)) return { status: 400, body: { error: 'Unknown plan.' } };
    const ref = `MYOPS-${randomBytes(12).toString('base64url')}`;
    const created = await rpc(client, 'myops_create_payment', { p_user_id: userId, p_plan: plan, p_order_ref: ref, p_reservation_minutes: 30 });
    const refused = {
      unconfirmed_user: [403, 'Confirm your email before purchasing.'],
      already_lifetime: [409, 'You already have lifetime access.'],
      sold_out: [409, 'All Founders 100 places are taken.'],
      reserved_out: [409, 'Remaining Founders 100 places are temporarily reserved. Try again shortly.'],
      founders_available: [409, 'Founders 100 places are still available.'],
    }[created.status];
    if (refused) return { status: refused[0], body: { error: refused[1] } };
    if (!['created', 'existing'].includes(created.status) || !REF.test(created.order_ref || '')) throw new Error('rpc_shape');
    let billCode = created.bill_code;
    if (!billCode) {
      try {
        billCode = await createBill({ orderRef: created.order_ref, origin });
      } catch {
        await rpc(client, 'myops_abort_checkout', { p_order_ref: created.order_ref });
        return { status: 502, body: { error: 'Payment gateway is unavailable. Try again later.' } };
      }
      const attached = await rpc(client, 'myops_attach_bill', { p_order_ref: created.order_ref, p_bill_code: billCode });
      if (!attached) return { status: 502, body: { error: 'Checkout could not be started. Try again.' } };
    }
    if (!BILL.test(billCode)) throw new Error('bill_shape');
    return { status: 200, body: { next: `${SANDBOX}/${billCode}` } };
  }

  async function audit({ userId }) {
    const ids = String(env.MYOPS_ADMIN_USER_IDS || '').split(',').map((id) => id.trim()).filter(Boolean);
    if (!ids.includes(userId)) return { status: 403, body: { error: 'Not authorised.' } };
    const client = admin();
    if (!client) return { status: 503, body: { error: 'Audit is not configured.' } };
    return { status: 200, body: await rpc(client, 'myops_admin_audit', { p_limit: 200 }) };
  }

  // Webhook entry. Returns { status, body }; 5xx makes the gateway retry.
  async function callback(fields) {
    const client = admin();
    if (!client || !gatewayConfigured()) return { status: 503, body: { error: 'not_configured' } };
    const f = {};
    for (const key of ['refno', 'status', 'reason', 'billcode', 'order_id', 'amount', 'transaction_id', 'hash']) {
      const value = fields?.[key];
      if (value !== undefined && (typeof value !== 'string' || value.length > 200)) return { status: 400, body: { error: 'invalid' } };
      f[key] = value;
    }
    if (!['1', '2', '3'].includes(f.status) || !REF.test(f.order_id || '') || !BILL.test(f.billcode || '')) {
      return { status: 400, body: { error: 'invalid' } };
    }
    const expected = createHash('md5').update(`${env.TOYYIBPAY_SANDBOX_SECRET_KEY}${f.status}${f.order_id}${f.refno ?? ''}ok`).digest('hex');
    const hashOk = typeof f.hash === 'string' && safeEqualHex(expected, f.hash);
    // A supplied hash must match. Failure/cancel is only accepted with a valid hash; success
    // is additionally confirmed with the gateway API below.
    if (f.hash !== undefined && !hashOk) return { status: 400, body: { error: 'invalid' } };
    if (f.status === '2') return { status: 200, body: { status: 'pending_ignored' } };
    if (f.status === '3' && !hashOk) return { status: 400, body: { error: 'invalid' } };

    const payment = await rpc(client, 'myops_get_payment', { p_order_ref: f.order_id });
    if (!payment || payment.gateway_bill_code !== f.billcode) return { status: 400, body: { error: 'invalid' } };

    const key = founderEventKey(f);
    let outcome = 'failed';
    let cents = 0;
    let txn = f.transaction_id && SAFE_TEXT.test(f.transaction_id) ? f.transaction_id : `${f.order_id}`;
    if (f.status === '3') {
      if (/cancel/i.test(f.reason || '')) outcome = 'canceled';
    } else {
      let paid;
      try {
        paid = await confirmPaid({ billCode: f.billcode, orderRef: f.order_id });
      } catch {
        return { status: 502, body: { error: 'verification_unavailable' } };
      }
      if (!paid || paid.cents === null) return { status: 400, body: { error: 'unverified' } };
      outcome = 'succeeded';
      cents = paid.cents;
      if (paid.ref) txn = paid.ref;
    }
    const result = await rpc(client, 'myops_settle_payment', {
      p_order_ref: f.order_id, p_bill_code: f.billcode, p_txn_ref: txn, p_amount_cents: cents, p_outcome: outcome, p_event_key: key,
    });
    const ok = ['settled', 'already_settled', 'failed', 'canceled'].includes(result.status);
    return { status: ok ? 200 : 400, body: { status: result.status } };
  }

  return { founders, checkout, audit, callback };
}
