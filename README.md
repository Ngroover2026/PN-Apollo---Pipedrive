# Apollo → Pipedrive reply sync

A tiny webhook (no Zapier, no Make, no monthly automation-platform fee) that listens for Apollo
"contact replied" events and syncs them straight into Pipedrive:

- finds the Pipedrive Person by email (creates one if it doesn't exist yet)
- finds their open Deal (creates one if there isn't one) and moves it to your "Replied" stage
- logs a follow-up call activity due today, so it shows up on your task list / phone

It runs as one file (`api/apollo-reply.js`) on Vercel's free tier. You don't need to know Node.js to
deploy it — just follow the steps below.

## 1. Deploy it (about 5 minutes)

1. Create a free account at [vercel.com](https://vercel.com) (you can sign up with GitHub, GitLab, or email).
2. Put this folder in its own GitHub repo (easiest: create a new empty repo on GitHub, then drag these
   files into it via the GitHub web UI — "Add file → Upload files").
3. In Vercel: **Add New → Project**, import that repo, click **Deploy**. No build settings needed —
   Vercel auto-detects the `api/` folder.
4. Once deployed, Vercel gives you a URL like `https://apollo-pipedrive-webhook.vercel.app`. Your
   webhook endpoint is that URL + `/api/apollo-reply`, e.g.
   `https://apollo-pipedrive-webhook.vercel.app/api/apollo-reply`.

## 2. Set the environment variables

In Vercel: **Project → Settings → Environment Variables**, add each one from `.env.example`
(`PIPEDRIVE_DOMAIN`, `PIPEDRIVE_API_TOKEN`, `PIPEDRIVE_REPLIED_STAGE_ID`, `WEBHOOK_SECRET`, and
optionally `PIPEDRIVE_PIPELINE_ID`). See the comments in that file for exactly where to find each
value in Pipedrive. After adding them, **redeploy** (Vercel → Deployments → ⋯ → Redeploy) so the
function picks them up.

## 3. Wire it up in Apollo

1. In Apollo: **Workflows → Create Workflow**.
2. Trigger: **Email replied**.
3. Action: **Send webhooks**.
   - Method: `POST`
   - URL: your Vercel URL from step 1 (`.../api/apollo-reply`)
   - Headers: add `X-Webhook-Secret` = the same value you set for `WEBHOOK_SECRET` in Vercel
   - Body: map the contact's email, name, and company (Apollo's builder shows you the merge fields
     — map them to `email`, `name`, `company` so the webhook can read them; the code also checks a
     couple of common alternate field names in case Apollo's defaults differ)
4. Save and turn the workflow on.

## 4. Test it

Reply to one of your own test sequence emails (or wait for a real reply) and check:
- Vercel → your project → **Logs**, to see the request come in and confirm it returned
  `{"ok": true, ...}`
- Pipedrive, to confirm the deal moved stage (or a new one was created) and a follow-up activity
  was added

## Notes

- This is intentionally simple: one file, no dependencies, nothing to maintain beyond the four
  environment variables. If Apollo ever changes its webhook payload shape, the fix is just editing
  the `extractContact` function in `api/apollo-reply.js` to read the new field names.
- Vercel's free tier is generous enough for this volume (a function call per reply) — you shouldn't
  hit any billing.
- Keep `WEBHOOK_SECRET` private. Anyone with your endpoint URL *and* that header value could create
  fake deals in your Pipedrive, but without the header they get a 401 and nothing happens.
