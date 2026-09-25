// api/apollo-reply.js
//
// Receives a webhook from an Apollo Workflow ("Email replied" trigger -> "Send webhooks" action)
// and syncs the reply into Pipedrive: finds the matching Person, finds their open Deal (or creates
// one), moves it to your "Replied" stage, and logs an activity/task so the reply doesn't sit unread.
//
// Deploy target: Vercel serverless function (Node 18+, no extra dependencies needed — uses the
// built-in fetch). See ../README.md for step-by-step deploy + Apollo/Pipedrive setup instructions.

const REQUIRED_ENV = [
  "PIPEDRIVE_DOMAIN", // e.g. "microgridpower" if your Pipedrive URL is microgridpower.pipedrive.com
  "PIPEDRIVE_API_TOKEN",
  "PIPEDRIVE_REPLIED_STAGE_ID", // the numeric stage id to move a replied deal into
  "WEBHOOK_SECRET", // a password you invent; Apollo sends it back as a header so randoms can't hit this URL
];

function pipedriveUrl(path, query = {}) {
  const base = `https://${process.env.PIPEDRIVE_DOMAIN}.pipedrive.com/api/v1${path}`;
  const params = new URLSearchParams({ api_token: process.env.PIPEDRIVE_API_TOKEN, ...query });
  return `${base}?${params.toString()}`;
}

// Apollo's webhook payload shape can vary depending on which fields you map in the workflow builder.
// This pulls the contact's email out of whichever shape shows up so the integration doesn't break
// if Apollo changes the exact field names later.
function extractContact(body) {
  const email =
    body.email ||
    body.contact_email ||
    body?.contact?.email ||
    body?.person?.email ||
    (Array.isArray(body?.contact?.emails) ? body.contact.emails[0] : undefined);

  const name =
    body.name ||
    body.contact_name ||
    body?.contact?.name ||
    [body?.contact?.first_name, body?.contact?.last_name].filter(Boolean).join(" ") ||
    undefined;

  const company =
    body.company ||
    body.account_name ||
    body?.contact?.organization_name ||
    body?.account?.name ||
    undefined;

  return { email, name, company };
}

async function findPersonByEmail(email) {
  const res = await fetch(
    pipedriveUrl("/persons/search", { term: email, fields: "email", exact_match: "true" })
  );
  const data = await res.json();
  const item = data?.data?.items?.[0]?.item;
  return item || null;
}

async function createPerson({ email, name }) {
  const res = await fetch(pipedriveUrl("/persons"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: name || email,
      email: [{ value: email, primary: true }],
    }),
  });
  const data = await res.json();
  return data?.data || null;
}

async function findOpenDealForPerson(personId) {
  const res = await fetch(pipedriveUrl("/deals", { person_id: personId, status: "open" }));
  const data = await res.json();
  return data?.data?.[0] || null;
}

async function createDeal({ personId, title }) {
  const body = {
    title: title || "Replied — new deal",
    person_id: personId,
    stage_id: process.env.PIPEDRIVE_REPLIED_STAGE_ID,
  };
  if (process.env.PIPEDRIVE_PIPELINE_ID) body.pipeline_id = process.env.PIPEDRIVE_PIPELINE_ID;

  const res = await fetch(pipedriveUrl("/deals"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  return data?.data || null;
}

async function moveDealToRepliedStage(dealId) {
  const res = await fetch(pipedriveUrl(`/deals/${dealId}`), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ stage_id: process.env.PIPEDRIVE_REPLIED_STAGE_ID }),
  });
  return res.json();
}

async function createFollowUpActivity({ personId, dealId, subject }) {
  const today = new Date().toISOString().slice(0, 10);
  await fetch(pipedriveUrl("/activities"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      subject: subject || "Follow up on Apollo reply",
      type: "call",
      due_date: today,
      person_id: personId,
      deal_id: dealId,
    }),
  });
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "Use POST" });
    return;
  }

  const missing = REQUIRED_ENV.filter((key) => !process.env[key]);
  if (missing.length) {
    res.status(500).json({ ok: false, error: `Missing env vars: ${missing.join(", ")}` });
    return;
  }

  const secret = req.headers["x-webhook-secret"];
  if (secret !== process.env.WEBHOOK_SECRET) {
    res.status(401).json({ ok: false, error: "Bad or missing X-Webhook-Secret header" });
    return;
  }

  try {
    const { email, name, company } = extractContact(req.body || {});
    if (!email) {
      res.status(400).json({ ok: false, error: "No contact email found in payload", received: req.body });
      return;
    }

    let person = await findPersonByEmail(email);
    if (!person) {
      person = await createPerson({ email, name });
    }
    if (!person) {
      res.status(502).json({ ok: false, error: "Could not find or create a Pipedrive person" });
      return;
    }

    let deal = await findOpenDealForPerson(person.id);
    let dealAction = "updated";
    if (!deal) {
      deal = await createDeal({ personId: person.id, title: `${name || email}${company ? " — " + company : ""}` });
      dealAction = "created";
    } else {
      await moveDealToRepliedStage(deal.id);
    }

    await createFollowUpActivity({
      personId: person.id,
      dealId: deal?.id,
      subject: `${name || email} replied — follow up`,
    });

    res.status(200).json({
      ok: true,
      person_id: person.id,
      deal_id: deal?.id,
      deal_action: dealAction,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
};
