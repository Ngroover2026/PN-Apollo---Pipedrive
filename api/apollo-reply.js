// api/apollo-reply.js
//
// Receives a webhook from an Apollo Workflow ("Email replied" trigger -> "Send webhooks" action)
// and syncs the reply into Pipedrive: finds the matching Person, and creates a Lead in your Leads
// Inbox for it (or logs a follow-up activity against an existing open Lead for that person, rather
// than creating a duplicate one), so someone reviews it before it becomes a full pipeline Deal.
//
// Safety filter: if the reply text looks like an opt-out / do-not-contact / out-of-office / wrong-
// person reply, we still record the Person (for a paper trail) but we do NOT create a Lead or book
// a follow-up call — instead we log a note on the Person explaining why it was skipped. This is a
// basic keyword filter, not sentiment analysis - if you can get Apollo's own reply-sentiment
// classification into the webhook body (a merge tag such as {{reply.sentiment}}, if your Workflow
// exposes one), that will be much more reliable than string matching and this filter can defer to it.
//
// Deploy target: Vercel serverless function (Node 18+, no extra dependencies needed — uses the
// built-in fetch).

const REQUIRED_ENV = [
  "PIPEDRIVE_DOMAIN",
  "PIPEDRIVE_API_TOKEN",
  "WEBHOOK_SECRET",
];

// Basic keyword filter for opt-out / do-not-contact / not-a-fit replies.
// Not exhaustive, and not a substitute for real sentiment classification - just a safety net so an
// obvious "remove me" or "wrong person" reply doesn't automatically generate a same-day call task.
const DNC_KEYWORDS = [
  "unsubscribe",
  "remove me",
  "remove my",
  "take me off",
  "do not contact",
  "don't contact",
  "do not email",
  "don't email",
  "do not call",
  "don't call",
  "stop emailing",
  "stop contacting",
  "opt out",
  "opt-out",
  "not interested",
  "no longer interested",
  "wrong person",
  "wrong contact",
  "out of office",
  "automatic reply",
  "auto-reply",
  "auto reply",
  "no longer with",
  "no longer at",
];

function pipedriveUrl(path, query = {}) {
  const base = `https://${process.env.PIPEDRIVE_DOMAIN}.pipedrive.com/api/v1${path}`;
  const params = new URLSearchParams({ api_token: process.env.PIPEDRIVE_API_TOKEN, ...query });
  return `${base}?${params.toString()}`;
}

// Throws if the Pipedrive response isn't ok, so a failed call can never silently look like success.
async function pipedriveFetch(path, options, query = {}) {
  const res = await fetch(pipedriveUrl(path, query), options);
  let data;
  try {
    data = await res.json();
  } catch (err) {
    throw new Error(`Pipedrive request to ${path} returned non-JSON response (status ${res.status})`);
  }
  if (!res.ok || data?.success === false) {
    const message = data?.error || data?.error_info || `HTTP ${res.status}`;
    throw new Error(`Pipedrive request to ${path} failed: ${message}`);
  }
  return data;
}

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

  const mobile =
    body.mobile ||
    body.mobile_number ||
    body?.contact?.mobile_number ||
    body?.contact?.phone ||
    undefined;

  // Which Pipedrive user should own the resulting Person/Lead.
  const ownerId = body.owner_id || undefined;

  // Best-effort: pull the actual reply text if the Apollo Workflow webhook body includes it.
  // Apollo doesn't have one fixed field name for this across accounts, so we check several
  // likely spots. If your Workflow's merge-tag picker exposes a reply-body or reply-sentiment
  // tag, add it to the webhook JSON body under one of these keys (or add a new one below).
  const replyText =
    body.reply_body ||
    body.reply_text ||
    body.email_body ||
    body.message ||
    body?.reply?.body ||
    body?.contact?.last_reply_body ||
    undefined;

  const replySentiment = body.reply_sentiment || body?.reply?.sentiment || undefined;

  return { email, name, company, mobile, ownerId, replyText, replySentiment };
}

// Returns { flagged: boolean, reason: string|null }
function checkDoNotContact({ replyText, replySentiment }) {
  if (replySentiment) {
    const sentiment = String(replySentiment).toLowerCase();
    const negative = ["not_interested", "not interested", "unsubscribe", "do_not_contact", "do not contact", "ooo", "out_of_office"];
    if (negative.some((s) => sentiment.includes(s))) {
      return { flagged: true, reason: `Apollo reply sentiment: "${replySentiment}"` };
    }
  }

  if (replyText) {
    const lower = String(replyText).toLowerCase();
    const hit = DNC_KEYWORDS.find((kw) => lower.includes(kw));
    if (hit) {
      return { flagged: true, reason: `Reply text matched keyword: "${hit}"` };
    }
  }

  return { flagged: false, reason: null };
}

async function findPersonByEmail(email) {
  const data = await pipedriveFetch("/persons/search", undefined, {
    term: email,
    fields: "email",
    exact_match: "true",
  });
  const item = data?.data?.items?.[0]?.item;
  if (!item) return null;

  const fullData = await pipedriveFetch(`/persons/${item.id}`);
  return fullData?.data || item;
}

async function createPerson({ email, name, mobile, ownerId }) {
  const body = {
    name: name || email,
    email: [{ value: email, primary: true }],
  };
  if (mobile) body.phone = [{ value: mobile, primary: true, label: "mobile" }];
  if (ownerId) body.owner_id = ownerId;

  const data = await pipedriveFetch("/persons", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return data?.data || null;
}

async function updatePersonMobileIfMissing(personId, mobile, existingPhone) {
  const hasPhone = Array.isArray(existingPhone) && existingPhone.some((p) => p?.value);
  if (hasPhone || !mobile) return;

  await pipedriveFetch(`/persons/${personId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      phone: [{ value: mobile, primary: true, label: "mobile" }],
    }),
  });
}

async function addNoteToPerson(personId, content) {
  await pipedriveFetch("/notes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      content,
      person_id: personId,
    }),
  });
}

async function findOpenLeadForPerson(personId) {
  const data = await pipedriveFetch("/leads", undefined, { person_id: personId });
  const leads = data?.data || [];

  return (
    leads.find((l) => {
      if (l.is_archived) return false;
      const linkedPersonId = typeof l.person_id === "object" ? l.person_id?.value : l.person_id;
      return String(linkedPersonId) === String(personId);
    }) || null
  );
}

async function createLead({ personId, title, ownerId }) {
  const body = {
    title: title || "Replied — new lead",
    person_id: personId,
  };
  if (ownerId) body.owner_id = ownerId;

  const data = await pipedriveFetch("/leads", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return data?.data || null;
}

async function createFollowUpActivity({ personId, leadId, subject, ownerId }) {
  const today = new Date().toISOString().slice(0, 10);
  const body = {
    subject: subject || "Follow up on Apollo reply",
    type: "call",
    due_date: today,
    person_id: personId,
  };
  if (leadId) body.lead_id = leadId;
  if (ownerId) body.user_id = ownerId;

  await pipedriveFetch("/activities", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
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
    const { email, name, company, mobile, ownerId, replyText, replySentiment } = extractContact(req.body || {});
    if (!email) {
      res.status(400).json({ ok: false, error: "No contact email found in payload", received: req.body });
      return;
    }

    let person = await findPersonByEmail(email);
    if (!person) {
      person = await createPerson({ email, name, mobile, ownerId });
    } else {
      await updatePersonMobileIfMissing(person.id, mobile, person.phone);
    }
    if (!person) {
      res.status(502).json({ ok: false, error: "Could not find or create a Pipedrive person" });
      return;
    }

    const dnc = checkDoNotContact({ replyText, replySentiment });
    if (dnc.flagged) {
      await addNoteToPerson(
        person.id,
        `Apollo reply auto-sync skipped creating a Lead/follow-up call.\nReason: ${dnc.reason}\n` +
          (replyText ? `Reply excerpt: "${String(replyText).slice(0, 300)}"` : "(no reply text available in webhook payload)")
      );

      res.status(200).json({
        ok: true,
        person_id: person.id,
        lead_action: "skipped_do_not_contact",
        reason: dnc.reason,
      });
      return;
    }

    let lead = await findOpenLeadForPerson(person.id);
    let leadAction = "reused_existing";
    if (!lead) {
      lead = await createLead({
        personId: person.id,
        title: `${name || email}${company ? " — " + company : ""}`,
        ownerId,
      });
      leadAction = "created";
    }

    await createFollowUpActivity({
      personId: person.id,
      leadId: lead?.id,
      subject: `${name || email} replied — follow up`,
      ownerId,
    });

    res.status(200).json({
      ok: true,
      person_id: person.id,
      lead_id: lead?.id,
      lead_action: leadAction,
    });
  } catch (err) {
    // Any Pipedrive call that failed above throws, so we land here instead of silently
    // reporting success with nothing actually created.
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
};
