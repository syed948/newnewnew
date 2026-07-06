# Brandigade Dialer — Vercel Serverless Edition

A calling + texting tool for Brandigade's team, built on Twilio, rewritten to run as native
Vercel Serverless Functions (no Express, no long-running server, no VPS).

- **User app** (`/app`): Dialer, Recent calls, SMS
- **Admin panel** (`/admin`): everything above, plus Team (create/disable/reset teammates) and Settings (Twilio API keys)
- **Auth**: email + password, JWT-based, accounts are created only by an admin

> **Function count:** This project intentionally ships as **8** serverless functions, well
> under Vercel Hobby's 12-function limit. See "Project structure" below for how related routes
> are grouped to make that work.


## What changed from the Express version

| | Before | Now |
|---|---|---|
| Server | `server/index.js` running Express, `app.listen(PORT)` | No server process at all — every route in `api/*.js` is its own Vercel Function |
| Routing | `express.Router()` | File-system routing (`api/admin/users/[id].js` → `/api/admin/users/:id`) |
| Database | SQLite file on local disk | **Postgres** (see below — this is the one change that isn't optional) |
| Middleware | `app.use(cors())`, custom `requireAuth`/`requireAdmin` | `withApi()` / `withAuth()` / `withAdmin()` wrapper functions in `lib/http.js`, applied per-function |
| Frontend paths | Templated with a `%%BASE%%` token for sub-path hosting | Root-relative (`/api/...`, `/css/...`) since this deploys to its own subdomain |

### Why Postgres and not SQLite

Vercel Functions don't guarantee the same container (or any disk) between invocations — a
SQLite file written during one request may simply not be there for the next one, and two
concurrent requests can hit two different containers with two different files. That's fine
for local development but not for production state like user accounts or call history. This
rewrite uses Postgres instead, reached over a normal connection string (`DATABASE_URL`), which
works identically whether it's Vercel Postgres, Neon, or Supabase.

## Project structure

Vercel's Hobby (free) tier caps a project at **12 serverless functions total**. To stay well
under that while keeping every route, related endpoints are grouped behind catch-all files
(`[...action].js`) that dispatch internally on the path segment and HTTP method, rather than
one file per endpoint. This project uses **8 functions**:

```
api/
  auth/
    [...action].js       ALL of: POST /api/auth/login, POST /api/auth/logout,
                          GET|POST /api/auth/verify, GET /api/auth/me
  admin/
    users/
      index.js            GET list / POST create   (exact path: /api/admin/users)
      [...action].js       PATCH/DELETE /api/admin/users/:id,
                            POST /api/admin/users/:id/reset-password
    settings.js            GET / PUT Twilio credentials
    calls.js               GET org-wide call log
    messages.js            GET org-wide SMS log
  calls/
    [...action].js        ALL of: GET /api/calls/token, POST /api/calls/voice,
                           POST /api/calls/status, GET /api/calls/list, POST /api/calls/log
  sms/
    [...action].js        ALL of: GET /api/sms/list, POST /api/sms/send, POST /api/sms/inbound
lib/
  database.js    Postgres pool + schema bootstrap (replaces server/db.js)
  auth.js         JWT + password helpers
  http.js          CORS, JSON responses, withApi/withAuth/withAdmin, rate limiting
  twilio.js         Twilio client + settings, initialized once and reused per warm container
  logger.js          Structured, secret-redacting logging
public/
  index.html, app.html, admin.html, css/, js/, assets/   (same UI as before, root-relative paths)
vercel.json
test-harness.js   Optional: exercises every handler directly against a real Postgres DB, no HTTP server needed
```

**Twilio Console URLs are unaffected by this consolidation** — `/api/calls/voice`,
`/api/calls/status`, and `/api/sms/inbound` are still the exact paths to configure, since the
catch-all reads the path segment after `/calls/` or `/sms/` the same way a dedicated file
would. The only paths that changed are two the frontend calls internally: recent-calls history
moved from `GET /api/calls` to `GET /api/calls/list`, and SMS history/send moved from
`/api/sms` to `/api/sms/list` and `/api/sms/send` — both already updated in `public/js/`.

If you later add more routes and start approaching the 12-function ceiling again, add a new
`case` to the relevant catch-all's `switch` statement instead of a new file, or upgrade to
Vercel Pro (which raises the limit substantially).

### A note on `vercel.json` and function settings

`vercel.json` intentionally does **not** set a `functions` block with custom memory/duration.
An earlier version of this config used a glob like `"api/**/*.js"` to raise memory/timeout on
every function, but Vercel's glob matcher can fail to resolve that pattern against the
bracket-named catch-all files here (`[...action].js`), causing a
`The pattern ... doesn't match any Serverless Functions` deploy error. Vercel's defaults
(1024 MB memory, 10s duration on Hobby, higher on Pro) are more than enough for this app. To
raise a specific function's limits later, set it by its literal file path (e.g.
`"api/calls/[...action].js": { "memory": 512 }`) rather than a glob, or adjust it from the
Vercel dashboard under Project Settings → Functions instead.


## Local development

You need Node 18+ and a Postgres database (a free Neon or Supabase project is the fastest way
to get one, or run Postgres locally / in Docker).

```bash
npm install
cp .env.example .env
# edit .env: set DATABASE_URL, JWT_SECRET, BOOTSTRAP_ADMIN_EMAIL/PASSWORD
npm run dev     # runs `vercel dev` - serves /public and /api together on http://localhost:3000
```

`vercel dev` replicates Vercel's routing and function execution locally, so what works there
works in production. First run will ask you to link a Vercel project — you can create one on
the spot or just say no and it'll still serve locally.

The first request against a fresh database creates the schema and a bootstrap admin
automatically (credentials from `.env`); watch the terminal log for confirmation.

### Testing without `vercel dev`

`test-harness.js` calls every serverless handler directly (login, admin CRUD, settings, voice
token, SMS) against `DATABASE_URL`, the same way Vercel's runtime would, without needing an
HTTP server:
```bash
DATABASE_URL=postgres://... node test-harness.js
```

## Deploying to Vercel

1. **Push this project to a GitHub repo.**
2. **Import it into Vercel** (vercel.com → Add New → Project → pick the repo). Vercel
   auto-detects the `api/` + `public/` structure — no build command needed.
3. **Add a Postgres database.** Easiest path: in the new Vercel project, go to
   *Storage → Create Database → Postgres* — this sets `DATABASE_URL` (actually a few
   `POSTGRES_*` vars) for you automatically. If you'd rather use Neon or Supabase, create the
   database there instead and paste its connection string into `DATABASE_URL` under
   *Settings → Environment Variables*. (If you use Vercel Postgres, update
   `lib/database.js`'s `DATABASE_URL` reference to whichever `POSTGRES_*` var it created, or
   simply add your own `DATABASE_URL` var pointing at the same value — either works.)
4. **Set the rest of the environment variables** (Settings → Environment Variables), copying
   from `.env.example`: `JWT_SECRET`, `APP_BASE_URL=https://dialer.brandigade.com`,
   `ALLOWED_ORIGINS`, `BOOTSTRAP_ADMIN_EMAIL`, `BOOTSTRAP_ADMIN_PASSWORD`. Leave the
   `TWILIO_*` vars blank for now — they can be added from the Settings screen once it's live.
5. **Deploy.** Vercel builds and deploys automatically on every `git push origin main`.
6. **Point your domain at it.** In the Vercel project → Settings → Domains, add
   `dialer.brandigade.com`. Vercel gives you a CNAME record to add at whatever DNS provider
   hosts `brandigade.com` (this doesn't touch your existing brandigade.com site at all — it's
   a separate subdomain pointing at a separate Vercel project).
7. **Log in** at `https://dialer.brandigade.com` with your bootstrap admin credentials.

### Troubleshooting: "404: NOT_FOUND" at the root URL after deploying

This means Vercel deployed successfully but didn't serve `public/index.html` at `/`. For a
plain (no-framework) project like this one, Vercel's zero-config static handling serves files
at their exact repo path — so without telling it otherwise, `public/index.html` is only
reachable at `/public/index.html`, not `/`. `vercel.json`'s `"outputDirectory": "public"`
fixes this by promoting everything in `public/` to the site root. If you still see the 404
after redeploying:
- Check **Project Settings → Build & Development Settings → Output Directory** in the Vercel
  dashboard isn't set to something else that overrides `vercel.json`.
- Check **Project Settings → General → Root Directory** is empty (or points at the repo root,
  not a subfolder) if this repo is nested inside a larger one.
- Trigger a fresh deployment after either change — Vercel doesn't retroactively re-route an
  existing deployment.

### Wiring up Twilio

In the Twilio Console:
- **TwiML App** → Voice Request URL: `https://dialer.brandigade.com/api/calls/voice` (HTTP POST)
- **Phone number** → Messaging → "A message comes in": `https://dialer.brandigade.com/api/sms/inbound` (HTTP POST)

Then, logged in as admin, go to **Settings** and fill in the Account SID, Auth Token, API
Key/Secret, TwiML App SID, and phone number. Once your webhook URLs match `APP_BASE_URL`
exactly, set `TWILIO_VALIDATE_SIGNATURE=true` in your Vercel environment variables to enforce
`X-Twilio-Signature` verification on the two webhooks.

### Adding your team

**Admin Panel → Team → Add teammate.** Each new account shows a one-time temporary password to
hand to that person; they can't self-register. Admins can disable, re-enable, reset the
password for, or delete any teammate from the same screen.

## Notes on the serverless-specific tradeoffs

- **Twilio Voice SDK loads from jsDelivr, not `sdk.twilio.com`.** Twilio retired their own CDN
  hosting as of Voice SDK 2.0 — `https://sdk.twilio.com/js/voice/releases/...` URLs no longer
  serve anything, which surfaces in the browser as `Twilio is not defined` (the script tag
  fails to load, so the global never gets created). `public/app.html` and `public/admin.html`
  instead load `https://cdn.jsdelivr.net/npm/@twilio/voice-sdk@2/dist/twilio.min.js`, jsDelivr's
  mirror of the same npm package Twilio tells you to install. The `@2` pins the major version
  (matching what the rest of this app expects) while still picking up minor/patch updates
  automatically.

- **Catch-all routing parses `req.url` directly, not `req.query.action`.** An earlier version
  of this project assumed Vercel would auto-populate `req.query.action` with the path segments
  matched by a file like `api/auth/[...action].js` — that convenience is actually specific to
  Next.js's request wrapper, not something plain (non-framework) Vercel Serverless Functions get
  automatically. `getActionSegments()` in `lib/http.js` parses the segments from `req.url`
  itself instead, which works regardless of framework. If you ever see a `"Unknown ... route"`
  JSON error where the request clearly reached the right function, this is the mechanism to
  check first.

- **Rate limiting** (`lib/http.js`) is in-memory per warm function instance — it meaningfully
  slows down brute-force attempts hitting the same warm container, but isn't a hard guarantee
  across every concurrent instance. For that, add [Upstash Ratelimit](https://upstash.com/docs/redis/sdks/ratelimit-ts/overview)
  (a Redis-backed limiter built for serverless) — swap it in inside `rateLimit()`.
- **Logout is stateless.** JWTs aren't stored server-side, so logging out just means the
  client discards its token; the `/api/auth/logout` call exists for consistent logging and as
  a hook point if you later want a token denylist (see the comment in that file).
- **Cold starts.** The first request after idle time pays the cost of opening a Postgres
  connection and (once) creating the schema. Subsequent requests on the same warm container
  reuse the pool and skip schema checks — this is cached in `global`, which is the standard
  pattern for reusing resources across invocations on Vercel.
