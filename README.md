# OnePWS Mail Merge

A standalone personal Chrome extension using your OnePWS logo and favicon. It sends directly through your own Google account. There is no subscription system, trial, paid feature gate, or OnePWS daily sending cap. Google's account sending limits and API quotas still apply.

## Included

- OnePWS extension icons, workspace logo, page favicon, and Gmail launcher.
- CSV upload or paste, selectable email column, invalid-address checks, and duplicate removal.
- Plain-text personalized messages with `{{ColumnName}}` fields, per-recipient previews, and test emails.
- Explicit campaign review, individual Gmail deliveries, configurable spacing, pause/resume, and CSV delivery reports.
- Local draft and campaign persistence. Access tokens stay managed by Chrome Identity.
- Persistent delivery IDs: completed messages are not resent when resuming. Interrupted or ambiguous sends pause for manual checking in Gmail Sent.
- A redesigned campaign studio with live overview cards, pre-send checklist, campaign names, searchable recipients, and previous/next preview navigation.
- Locally bundled Be Vietnam Pro typefaces across the workspace and Gmail launcher; no remote font requests.
- A template library to save, apply, and delete reusable subjects/messages without storing contact lists in templates.
- Privacy controls for session-only workspace storage and explicit deletion of saved data plus Gmail disconnection.

This is a new personal mail-merge implementation, not feature parity with the previous server-backed product. It does not include attachments, HTML email, open/click tracking, reply detection, automated follow-ups, scheduled background campaigns, Google Sheets integration, or SMTP delivery. Scheduling and tracking would need additional development and potentially a hosted backend. Keep the workspace tab open and Chrome awake during a campaign; campaign progress resumes manually after a restart.

## One-time Google setup

1. Open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select this folder. Pin **OnePWS Mail Merge** if desired.
2. Copy the extension ID shown by Chrome or in the workspace's **Setup guide**. The included manifest public key keeps this ID stable. Do not remove or regenerate that key.
3. Create a project in [Google Cloud](https://console.cloud.google.com/) and enable the **Gmail API**.
4. Configure **Google Auth Platform** branding and audience. For personal testing with an External app, add your own Gmail address as a test user. A Workspace Internal app is another option if your organization supports it. Google's consent/testing policies and Workspace administrator settings determine access.
5. Configure the requested scopes: `https://www.googleapis.com/auth/gmail.send` and `https://www.googleapis.com/auth/userinfo.email`. The extension needs sending access and the identity of the sending account; it does not request inbox reading access.
6. Create an OAuth client with application type **Chrome Extension** and the exact extension ID from step 2. A web application client or service account is not interchangeable.
7. With Node.js installed, run this command in the extension folder, replacing the example with your real client ID:

   ```powershell
   node scripts/configure.mjs 123456789-your-client.apps.googleusercontent.com
   ```

8. Reload OnePWS at `chrome://extensions`, reopen its workspace, and click **Connect Gmail**. Approve Google access using your intended sender account. The account address is displayed before sending.

Only the OAuth **client ID** is needed. No client secret, paid mail service, or separate backend is required for the included features. Use Chrome with a signed-in browser profile. If you see an OAuth error, check that the Gmail API is enabled, the client is a Chrome Extension client, the extension IDs match, and your account is an allowed test user. Disconnecting clears local cached tokens; to revoke the Google grant entirely, remove the app from your Google account's third-party access settings.

Reference: [Chrome extension OAuth setup](https://developer.chrome.com/docs/extensions/how-to/integrate/oauth), [Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes), and [Gmail API sending format](https://developers.google.com/workspace/gmail/api/guides/sending).

## Use

Import UTF-8 CSV contacts with a header such as `Email,FirstName,Company` by upload, drag and drop, or paste. Browser imports are limited to 4 MB to avoid excessive memory/storage usage; this is a file-size guard, not a subscription or daily sending limit. Select the address column, then write your subject and message. Insert fields such as `{{FirstName}}` using the field buttons. Column names are case-sensitive. Invalid addresses block sending until corrected; duplicate addresses are sent only once per campaign. Search the recipient table to inspect contacts; it displays up to 50 matches at a time while every valid imported contact remains included in the campaign. A malformed import clears the prior active list.

Review several recipients, send a test to your own address, then choose **Review campaign** and confirm the exact sender and recipient count. Sending a test is a real email to the test address. Campaigns stop on the first failed or unconfirmed delivery. **Review & resume** retries definite failures and remaining contacts; it skips sent and unconfirmed messages. Check unconfirmed deliveries in Gmail Sent. If you need to resend those, create a separate CSV containing only recipients you have confirmed were not sent. Starting a new campaign resets its progress and makes its contacts eligible to send again.

The Gmail floating launcher opens the same workspace. It does not extract your inbox or use Gmail's compose form. Connecting a different account requires starting a new campaign or reconnecting the original sender. **New campaign** clears the current contacts, subject, message, and campaign name after confirmation; save a template and export your report first.

Drafts, contacts, and campaign message contents are saved in this Chrome profile's extension storage by default. Under **Privacy & data**, turn **Remember my workspace** off to move the workspace to session memory; it then survives a tab reload but is cleared when Chrome exits, the extension reloads, or the extension is disabled. Saved templates and delivery receipts remain local until explicitly cleared. New delivery receipts contain a SHA-256 payload fingerprint, status, time, optional error, and Gmail message ID rather than the recipient address or message body. Older receipts may still contain recipient addresses until cleared.

**Clear data & disconnect** removes contacts, drafts, campaign progress, templates, preferences, and receipts, and clears Chrome's cached Gmail authorization. It does not delete email in Gmail or revoke the Google-side grant; use Google Account connections to revoke that. Clearing receipts removes duplicate-send protection for old campaigns. This extension does not encrypt saved data at rest; use a trusted, protected Chrome profile. No application can promise absolute security.

The extension sends data only to Google's user-info and Gmail API endpoints. Scripts, fonts, icons, logo, and favicon are bundled locally. There are no analytics, tracking pixels, or remote runtime dependencies. Gmail content scripts cannot read private extension storage or request sending/authentication actions. Clicking website or account-management links explicitly opens those external sites. See [security review and verification limits](docs/SECURITY-REVIEW.md).

## Development and validation

No build step or npm dependencies are required. Node.js 20 or newer is sufficient for the scripts and tests.

```powershell
node --test tests/*.test.js
node scripts/check.mjs
node scripts/ui-smoke.mjs
node scripts/extension-smoke.mjs
```

The UI smoke test uses locally installed Chrome or Edge with an isolated temporary profile and mocked delivery APIs under the extension's real Content Security Policy. It checks templates, privacy migration/deletion, pause/resume, malformed imports, text-injection handling, local font loading, workspace locking, and responsive layouts. It writes a preview to `docs/onepws-preview.png`.

The real-extension smoke test needs a Chromium or Chrome for Testing executable (set `CHROMIUM_PATH` if it is not found in the local Playwright cache). It loads the actual unpacked extension in an isolated profile and tests the manifest, service worker, runtime messages, local/session storage, reload recovery, Gmail launcher and its font, and content-script storage/action restrictions. Its Gmail-origin page is an intercepted local fixture, not your Gmail inbox. Neither browser test sends email or uses your signed-in Chrome profile. Live Google consent and actual Gmail delivery remain a manual check with your account and an explicitly chosen test recipient.

The original extension was preserved outside this active folder at `D:\onepws\extension-original-20261117.zip` and `D:\onepws\extension-original-source-20261117` before replacing its server-dependent implementation. These backups are not loaded by OnePWS.
