import { build } from 'vite';
const productionAuth = process.env.VERCEL_ENV === 'production' && process.env.MYOPS_ENABLE_PRODUCTION_AUTH === 'true';
await build({ mode: process.env.VERCEL_ENV === 'preview' ? 'preview-auth' : productionAuth ? 'production-auth' : 'production' });
