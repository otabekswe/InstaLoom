<picture>
  <source media="(prefers-color-scheme: dark)" srcset="public/brand/instaloom-logo-white.svg">
  <img src="public/brand/instaloom-logo.svg" alt="InstaLoom" width="246" height="48">
</picture>

A private Instagram inbox with automatic replies for **DMs, comments, and stories**. Each connected Business or Creator account has its own workspace. Multiple people can test the same deployment; each sees only their own inbox and automations.

**Free setup:** Vercel Hobby runs the app and backend; Neon Free stores data; cron-job.org recovers queued replies. No separate backend server or Vercel Pro needed. Stay within the providers' free quotas. [Vercel Hobby](https://vercel.com/docs/plans/hobby) is for personal, non-commercial use.

## 1. Prepare

Fork/clone this repository, install [Node.js 24](https://nodejs.org/en/download), then run:

```bash
corepack enable
yarn install --immutable
yarn setup:local
```

This creates `.env.local` and generates `WEBHOOK_VERIFY_TOKEN` and `CRON_SECRET`. Keep them private. All settings: [`.env.example`](.env.example).

## 2. Configure Meta and your Instagram account

1. Use an Instagram **Business or Creator** account. Open [Meta Developers → My Apps](https://developers.facebook.com/apps/), create/select your app, then open **Instagram → API setup with Instagram business login**. A Facebook Page is not required.
2. Copy credentials from that **Instagram** panel into `.env.local`:

   | Copy from Meta | Paste into `.env.local` |
   | --- | --- |
   | Instagram app ID | `INSTAGRAM_APP_ID` |
   | Instagram app secret → Show | `INSTAGRAM_APP_SECRET` |

   These are the Instagram credentials, not the separate app ID/secret under **App settings → Basic**.
3. Add your professional account under **Generate access tokens**. If a tester invitation is required, add the username in **App roles → Roles → Instagram Testers**, then accept it on Instagram under **Apps and websites → Tester invites** (in Settings/Website permissions). Use that same account throughout setup.
4. Leave `OWNER_INSTAGRAM_ID` empty to allow multiple Meta-authorized accounts. For **single-owner access**, generate the account's access token and run `yarn setup:owner`; paste the token when prompted. It saves the numeric owner ID, not the token. Existing local connections are detected automatically.
5. Configure these permissions for the app: `instagram_business_basic`, `instagram_business_manage_messages`, `instagram_business_manage_comments`. On Instagram, enable **Allow access to messages** under connected tools/message settings if shown.
6. Set `PRIVACY_CONTACT_NAME` and either `PRIVACY_CONTACT_EMAIL` or `PRIVACY_CONTACT_URL` in `.env.local`. These appear publicly on the policy pages.

**Testing with others:** remove `OWNER_INSTAGRAM_ID` from Vercel's **Production** environment and redeploy. Keep the Meta app in **Development**, add each professional account as an Instagram tester, and have them accept the invitation. Each tester signs in through their own browser. Sign out before switching accounts in the same browser.

Setting `OWNER_INSTAGRAM_ID` restricts access to that account again. Leaving it empty allows anyone Meta authorizes; the app does not check tester roles itself. In Live mode, access can extend beyond your testers.

## 3. Deploy

1. Push to GitHub. In [Vercel → Add New → Project](https://vercel.com/new), import the repository. Choose **Next.js**, Node **24.x**, install command `yarn install --immutable`, build command `yarn build`.
2. Add [Neon from Vercel Marketplace](https://vercel.com/marketplace/neon) and connect a database. Copy **Neon → Connect → Connection pooling → Connection string** into Vercel **Settings → Environment Variables → Production → `DATABASE_URL`**.
3. Add the remaining filled `.env.local` values to **Production**. Set `APP_URL=https://YOUR-PROJECT.vercel.app` (or your permanent custom domain), with no path/trailing slash. Keep secrets out of Git and preview deployments.
4. Deploy/redeploy. Tables are created automatically. Keep the production domain publicly reachable; Meta cannot use pages behind Vercel login protection.
5. In **Vercel → Settings → Cron Jobs**, confirm `/api/cron/maintenance` runs **once daily**. This checks Instagram tokens and fits [Hobby's cron limit](https://vercel.com/docs/cron-jobs/usage-and-pricing).

### Enable free recovery

Normal replies run immediately when Instagram sends a webhook. Add this free job to recover queued replies after interruptions, even when the app is closed:

1. Sign up at [cron-job.org](https://cron-job.org/en/) → **Create cronjob**.
2. Set URL to `https://YOUR-PROJECT.vercel.app/api/cron/maintenance?background=1`, method **GET**, schedule **every 15 minutes**.
3. Under **Advanced → Headers**, add `Authorization` with value `Bearer YOUR_CRON_SECRET`. Replace only `YOUR_CRON_SECRET` with the value from Vercel; keep `Bearer ` before it. Keep the secret out of the URL.
4. Enable failure notifications, save, then **Test run**. Expect **202**: maintenance was accepted for background processing. Check InstaLoom's **Recent replies** for delivery and Vercel **Logs** for worker errors.

The 15-minute interval lets an idle Neon database sleep between checks. Daily maintenance alone cannot reliably recover replies: queued work expires after one hour. Failed or uncertain sends are never retried automatically. The scheduler is [free and supports custom headers](https://cron-job.org/en/faq/); its success status confirms acceptance, not delivery.

**Move existing data (optional):** stop the app, back up `data`, set an **empty** destination's `DATABASE_URL`, then run `yarn db:import data/chatplace.db` (or `data/instaloom.db`). Reconnect Instagram and enable your imported rules. The source stays unchanged; old sessions and pending sends are not resumed.

## 4. Paste these URLs into Meta

Replace `YOUR-PROJECT.vercel.app` below with the **same domain as `APP_URL`**. These pages/routes are already included; you do not need to create or host them separately.

| URL/value to copy | Where to paste it in Meta |
| --- | --- |
| `https://YOUR-PROJECT.vercel.app/api/auth/instagram/callback` | Instagram → Set up Instagram business login → Valid OAuth Redirect URIs |
| `https://YOUR-PROJECT.vercel.app/api/webhook` | Instagram → Webhooks → Callback URL |
| Your `WEBHOOK_VERIFY_TOKEN` | Same Webhooks form → Verify token |
| `https://YOUR-PROJECT.vercel.app/privacy` | App settings → Basic → Privacy Policy URL |
| `https://YOUR-PROJECT.vercel.app/data-deletion` | App settings → Basic → User data deletion → select **Data deletion instructions URL** |
| `YOUR-PROJECT.vercel.app` (domain only) | App settings → Basic → App Domains, if requested |

**Find them in the app:** the welcome page footer links to **Privacy policy** and **Data deletion**. After signing in, **Settings → Connection setup / Public pages** has exact URLs, copy buttons, and links to open the pages.

Save the OAuth settings. In Webhooks, click **Verify and save**, then subscribe to **messages**, **messaging_postbacks**, **messaging_seen**, and **comments**. The callback must end in `/api/webhook`, not `/`.

Open both policy pages in a private/incognito window and check that your contact details appear. **Keep Development mode for tester-only access.** For wider access, complete Meta's requirements before switching **App Mode → Live**; Live mode does not replace required permissions or App Review. [Meta setup guide](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/get-started/)

## 5. Connect and use

Open your deployed `APP_URL` → **Continue with Instagram** → approve all requested permissions with your professional account. Complete authorization in the same browser.

- **Inbox:** read/reply to DMs; open **Automation** for automatic replies.
- **Post:** select a post → **New automation** → **Private Message**, **Reply to the comment**, or **Both**.
- **Story:** select a story → **New automation**.

Add words with **comma/Enter** (or select **Any**), then write a reply. **Save** keeps it paused; **Save & turn on** enables it. Multiple rules are supported; the first enabled match wins. Icons edit, pause/resume, and delete.

Test with a **new message/comment from another Instagram account**. Old Instagram messages are not imported. Each rule replies once per person per 24 hours. Check **Recent replies** for delivery; uncertain sends are not retried automatically.

## Common setup errors

| Message/problem | Fix |
| --- | --- |
| `Invalid redirect_uri` | Match the full OAuth URL above exactly, save it in **Instagram business login**, and redeploy after changing `APP_URL`. |
| `This workspace is private` | Sign in with the configured owner, or remove `OWNER_INSTAGRAM_ID` in Vercel and redeploy to allow other Meta-authorized accounts. |
| `Insufficient Developer Role` | Add/accept the Instagram tester invitation above. Ensure your Meta login has an app admin/developer role and retry with the invited Instagram account. |
| `Invalid Privacy Policy URL` | Use `/privacy`, publish contact details, redeploy, and verify the page opens without signing in. |
| Webhook returns `200`, but no reply | Check field subscriptions, tester access (or Live permissions), account connection, and that the matching rule is enabled. Send a new real event; `200` only confirms receipt. |

## Checks

```bash
yarn check                       # lint, types, tests, production build
yarn playwright install chromium
yarn test:e2e                    # isolated test database
```

Back up your database. Disconnecting stops processing but retains history; the operator handles deletion requests through the published contact.
