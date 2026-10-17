import { build } from 'vite';
// Production and ordinary local builds retain the original design-preview portal.
await build({ mode: process.env.VERCEL_ENV === 'preview' ? 'preview-auth' : 'production' });
