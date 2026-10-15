# MYOPS Workspace (Web MVP)

Independent Vite/React web workspace under `workspace/`. This is a UI prototype, **not** the MYOPS corporate marketing website.

## Local development
```bash
cd workspace
npm install
npm run dev
npm run build
```

## Vercel
Create a **separate** Vercel project from this GitHub repository with Root Directory `workspace`, framework Vite, build command `npm run build`, output `dist`. Do not replace the existing corporate website Vercel project.

## Security and functionality
- No Supabase keys, identity provider, authentication or payment endpoints connected.
- App launch buttons intentionally disabled until trusted destination URLs and SSO are implemented.
- No entitlement decisions in client code. Validate access in each module's backend.
- No cross-project Supabase secret keys in browser.
- Future phases: OIDC SSO, app registry, secure module deep links, subscription status, mobile Expo shell.
