# LUCKY FIVE — Secret Gift Exchange

A mobile-first installable PWA for a five-person Christmas gift exchange.

**Tagline:** Kersfees in Loeriesfontein saam met familie ❤️

## What this starter includes

- Create a game and share a seven-character invitation code/link.
- Five participants enter their own names; no names are preloaded.
- When the fifth person joins, the database assigns five unique random numbers (10–99).
- The host selects the two restricted couples after all five participants have joined. Gift recipients are assigned safely as each person spins Wheel 2.
- Each player reveals their own number with Wheel 1.
- Each player reveals only their own recipient with Wheel 2.
- Other players can see progress (joined / number revealed / gift draw completed), never another person's number or gift assignment.
- PWA manifest and service worker cache only the public app shell, never private API results.

## Important implementation note

The wheels animate on the phone. The server validates every gift draw, prevents self-draws, partner-draws and duplicate recipients, and checks that all remaining players can still be assigned. The wheel animation is the reveal experience; the server is authoritative.

## 1. Create a Supabase project

Create a free project at https://supabase.com/dashboard.

In **Project Settings → API**, copy:
- Project URL
- anon / publishable key

Put those values in `config.js`. The anon/publishable key is designed to be public. **Never put the service-role key in `config.js` or any browser file.**

## 2. Set up the database

In Supabase **SQL Editor**, run the complete contents of:

`supabase/migrations/001_lucky_five.sql`

The tables have Row Level Security enabled and no public policies. Browser clients do not read tables directly.

## 3. Deploy the Edge Function

Install the Supabase CLI and log in:

```bash
npm install -g supabase
supabase login
supabase link --project-ref YOUR_PROJECT_REF
supabase functions deploy lucky-five --no-verify-jwt
```

The Edge Function is deployed with JWT verification disabled because it validates high-entropy private player/admin tokens itself. It uses Supabase's server-side `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` environment variables. Supabase provides these to deployed Edge Functions. Do not expose the service role key to the browser.

## 4. Publish on Cloudflare Pages

Create a GitHub repository, for example `lucky-five`.

Upload the contents of this folder to the repository root. In Cloudflare:
1. Open **Workers & Pages → Create → Pages → Connect to Git**.
2. Select the `lucky-five` repository.
3. Framework preset: **None**.
4. Build command: leave blank.
5. Build output directory: `/` (the repository root).
6. Deploy.

The app is static, so no build step is needed.

## 5. Configure the app

Edit `config.js` before publishing:

```js
window.LUCKY_FIVE_CONFIG = {
  supabaseUrl: "https://YOUR_PROJECT_REF.supabase.co",
  supabaseAnonKey: "YOUR_ANON_OR_PUBLISHABLE_KEY"
};
```

Redeploy after committing the change.

## 6. Test before sharing

Use five different browsers/devices or private browser sessions:
1. Create a game on device 1 and join as player 1.
2. Open the invitation link on four other devices and join with four different names.
3. Confirm the fifth join changes the room to ready.
4. Each player spins Wheel 1. Confirm all five numbers are different.
5. Each player spins Wheel 2. Confirm no one draws themselves and no recipient appears twice.
6. Confirm a player can see only their own recipient, while other players see only completion status.
7. Refresh each browser and confirm its private result is still available.

## Current prototype limitations / next hardening steps

- The player session token is stored in that browser's local storage. Each person should use their own phone/browser and keep its site data until the exchange is complete.
- A lost browser session currently requires a controlled recovery/reset procedure; there is no account/password recovery screen yet.
- Add rate limiting / abuse protection before making the app public.
- The current app is a first deployable starter, not yet independently security-audited.
- The admin token is generated for the creator. An admin progress dashboard can be added without exposing gift assignments.

## Game rules encoded in the database

Exactly five players are required. Numbers are randomly selected from 10–99 with no duplicates. Each successful gift draw is stored server-side exactly once. Nobody can draw themselves or their partner, and each recipient can be selected only once. Each player can reveal only their own assigned number and their own gift recipient. No public database read policy is provided.
