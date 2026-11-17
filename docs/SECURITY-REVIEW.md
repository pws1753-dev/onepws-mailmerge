# OnePWS 1.1 security review

This is an implementation review with automated regression checks, not an independent security certification or Google OAuth approval.

## Controls verified

- Requests only Chrome `identity` and `storage` permissions, plus Gmail content injection. OAuth scopes remain `gmail.send` and `userinfo.email`; no inbox-read or full-mailbox scope was added.
- Content Security Policy permits local scripts, styles, fonts, and images, and API connections only to the two required Google hosts. No remote JavaScript, analytics, font CDN, or HTML insertion from imported data is used.
- Gmail content scripts can open the workspace but cannot call authentication, sending, status, or data-deletion actions. Both local and session storage are restricted to trusted extension contexts on every worker startup.
- Sender identity is obtained from Google and verified for each delivery. Expired tokens refresh on a definitive 401 rejection. Credentials are not written into workspace data or logs.
- A browser-wide workspace lock and a worker delivery lock prevent concurrent tabs/requests from racing. Delivery intent is persisted before Gmail dispatch.
- Persistent receipt IDs prevent repeat dispatch after success or an ambiguous interruption. Payload fingerprints prevent reusing a delivery ID for another message. HTTP 408, server errors, and network interruptions are treated as unconfirmed and are not automatically retried. A successful API response means Gmail accepted the message, not a guarantee of recipient inbox placement.
- Subject/email header injection, malformed CSV, missing merge columns, invalid addresses, and duplicate recipients are checked. Imported text is rendered with DOM text APIs. CSV reports escape spreadsheet formulas.
- Failed CSV imports discard the previous active list, preventing accidental sends to stale contacts. Files/pasted CSV over 4 MB are rejected before parsing.
- Autosave and privacy changes are serialized. Session-only mode removes the persistent workspace copy. Explicit data deletion waits for pending saves, clears application keys/receipts, and disconnects Chrome Identity without recreating erased drafts.
- Bundled Be Vietnam Pro font files have their SIL Open Font License included in `assets/fonts/OFL.txt`.

## Validation

Run `node --test tests/*.test.js`, `node scripts/check.mjs`, `node scripts/ui-smoke.mjs`, and `node scripts/extension-smoke.mjs`.

Pure tests cover CSV/MIME, injection defenses, duplicate dispatch, changed-payload rejection, token refresh, quota/timeouts, write failure, authorization, deletion boundaries, and privacy/save races. The UI test exercises the integrated workflow using mock mail delivery with the actual CSP. The unpacked-extension test checks real Chromium extension APIs and uses an intercepted local Gmail-origin fixture to test launcher loading and the content-script security boundary.

No real Google account consent, live API send, recipient delivery, spam classification, Google verification approval, or third-party penetration test is asserted by these automated results. Record a live test using an explicitly chosen recipient before relying on a campaign. The current Google verification submission and website privacy-policy content must accurately reflect these data practices.

## Remaining boundaries

Chrome local storage is not encrypted by this extension. Saved templates and receipts persist even when workspace remembering is disabled. Google retains sent mail and account data under its own policies. A compromised device, browser profile, extension source, or Google account is outside these controls. Session-only campaigns cannot recover after Chrome exits or the extension reloads. Storage quota failures stop sending; large campaigns may need to be split. Clearing receipts or deliberately starting a new campaign makes previously sent recipients eligible again. The project does not provide server-side scheduling, tracking, attachments, HTML mail, or automated follow-ups.
