// Safe placeholder: do not accept payment events until persistence and
// transaction reconciliation have been implemented.
export default function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  return res.status(503).json({ error: 'Payment callback processing is not enabled' });
}
