// Sandbox-only configuration health check. Never returns secrets.
export default function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const sandbox = process.env.TOYYIBPAY_MODE === 'sandbox';
  const configured = Boolean(process.env.TOYYIBPAY_SECRET_KEY && process.env.TOYYIBPAY_CATEGORY_CODE);
  return res.status(200).json({
    provider: 'toyyibpay',
    mode: sandbox ? 'sandbox' : 'disabled',
    configured: sandbox && configured,
    checkoutEnabled: false,
    reason: 'Checkout requires authenticated users and durable order storage',
  });
}
