// Fail closed: never create bills without authenticated tenant and persistent order record.
export default function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  return res.status(503).json({ error: 'Checkout is not enabled until authentication and order storage are configured' });
}
