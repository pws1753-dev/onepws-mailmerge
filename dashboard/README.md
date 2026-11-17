# OnePWS Mail Merge Dashboard

This is the central reporting service for OnePWS Mail Merge. It accepts signed campaign events from paired extensions and shows only events actually synced to MongoDB Atlas. It does not invent inbox-placement or deliverability data.

## Local setup

1. Copy `.env.example` to `.env` and set a unique `DASHBOARD_PASSWORD` and `DASHBOARD_SESSION_SECRET`.
2. Set the provided Atlas URI as `MONGODB_URI`; never put it in browser code or commit it.
3. From this directory run `npm.cmd install`, then `npm.cmd run dev`.
4. Open `http://localhost:3000`, sign in, and use **Pair Chrome extension**. The device secret is displayed once.

## Production at mailmerge.onepws.com

Use Hostinger Node.js hosting and set the variables from `.env.example` in its environment-variable panel. Set the application start command to `npm run start`, application root to `dashboard`, and port to Hostinger's assigned `PORT`. Point the subdomain at the Node application only after the hosting target is confirmed.

## Data signals

- Direct sending confirms `sent`; it cannot prove inbox placement.
- Delivery/bounce/reply needs connected provider webhooks or an authorized monitored mailbox.
- Opens/clicks require an HTML tracking implementation and an opt-in tracking domain.
- Inbox-vs-spam placement requires seed inboxes or a placement provider. Do not represent it as a fact without those signals.

## Security model

- Dashboard login uses an `HttpOnly`, `SameSite=Strict` signed, short-lived session cookie.
- Extension ingestion uses a per-device HMAC signature and timestamp; create/revoke device credentials from an authenticated dashboard only.
- The frontend never receives MongoDB credentials.
- Before real production use, replace dashboard-password login with Google Workspace/Google OAuth allow-listed access and add device revocation/audit screens.
