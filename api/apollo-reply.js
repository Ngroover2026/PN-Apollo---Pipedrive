// api/apollo-reply.js
//
// Receives a webhook from an Apollo Workflow ("Email replied" trigger -> "Send webhooks" action)
// and syncs the reply into Pipedrive: finds the matching Person, and creates a Lead in your Leads
// Inbox for it (or logs a follow-up activity against an existing open Lead for that person, rather
// than creating a duplicate one), so someone reviews it before it becomes a full pipeline Deal.
//
// Deploy target: Vercel serverless function (Node 18+, no extra dependencies needed — uses the
// built-in fetch). See ../README.md for step-by-step deploy + Apollo/Pipedrive setup instructions.

const REQUIRED_ENV = [
  "PIPEDRIVE_DOMAIN", // e.g. "microgridpower" if your Pipedrive URL is microgridpower.pipedrive.com
  "PIPEDRIVE_API_TOKEN",
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

  const mobile =
    body.mobile ||
    body.mobile_number ||
    body?.contact?.mobile_number ||
    body?.contact?.phone ||
    undefined;

  return { email, name, company, mobile };
}

async function findPersonByEmail(email) {
  const res = await fetch(
    pipedriveUrl("/persons/search", { term: email, fields: "email", exact_match: "true" })
  );
  const data = await res.json();
  const item = data?.data?.items?.[0]?.item;
  if (!item) return null;

  // The /persons/search "item" is a stripped-down summary that doesn't reliably include the
  // full phone array, so fetch the complete record — needed to correctly tell whether this
  // person already has a mobile number on file before we consider adding one.
  const fullRes = await fetch(pipedriveUrl(`/persons/${item.id}`));
  const fullData = await fullRes.json();
  return fullData?.data || item;
}

async function createPerson({ email, name, mobile }) {
  const body = {
    name: name || email,
    email: [{ value: email, primary: true }],
  };
  if (mobile) body.phone = [{ value: mobile, primary: true, label: "mobile" }];

  const res = await fetch(pipedriveUrl("/persons"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  return data?.data || null;
}

// Only fills in the phone number if the person doesn't already have one on file —
// never overwrites a number someone in Pipedrive may have already corrected/updated.
async function updatePersonMobileIfMissing(personId, mobile, existingPhone) {
  const hasPhone = Array.isArray(existingPhone) && existingPhone.some((p) => p?.value);
  if (hasPhone || !mobile) return;

  await fetch(pipedriveUrl(`/persons/${personId}`), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      phone: [{ value: mobile, primary: true, label: "mobile" }],
    }),
  });
}

async function findOpenLeadForPerson(personId) {
  // Pipedrive's /v1/leads list endpoint does accept a person_id filter, but given the earlier
  // /deals endpoint silently ignored an equivalent filter and caused a real record to get modified
  // by mistake, we don't trust the filter alone here either — every result is re-checked below to
  // confirm it's genuinely linked to this exact person before we ever act on it.
  const res = await fetch(pipedriveUrl("/leads", { person_id: personId }));
  const data = await res.json();
  const leads = data?.data || [];

  return (
    leads.find((l) => {
      if (l.is_archived) return false; // don't reuse a lead that's already been actioned/archived
      const linkedPersonId = typeof l.person_id === "object" ? l.person_id?.value : l.person_id;
      return String(linkedPersonId) === String(personId);
    }) || null
  );
}

async function createLead({ personId, title }) {
  const res = await fetch(pipedriveUrl("/leads"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: title || "Replied — new lead",
      person_id: personId,
    }),
  });
  const data = await res.json();
  return data?.data || null;
}

async function createFollowUpActivity({ personId, leadId, subject }) {
  const today = new Date().toISOString().slice(0, 10);
  const body = {
    subject: subject || "Follow up on Apollo reply",
    type: "call",
    due_date: today,
    person_id: personId,
  };
  if (leadId) body.lead_id = leadId;

  await fetch(pipedriveUrl("/activities"), {
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
    const { email, name, company, mobile } = extractContact(req.body || {});
    if (!email) {
      res.status(400).json({ ok: false, error: "No contact email found in payload", received: req.body });
      return;
    }

    let person = await findPersonByEmail(email);
    if (!person) {
      person = await createPerson({ email, name, mobile });
    } else {
      // Existing person: only fill in the mobile number if they don't already have one on file.
      await updatePersonMobileIfMissing(person.id, mobile, person.phone);
    }
    if (!person) {
      res.status(502).json({ ok: false, error: "Could not find or create a Pipedrive person" });
      return;
    }

    let lead = await findOpenLeadForPerson(person.id);
    let leadAction = "reused_existing";
    if (!lead) {
      lead = await createLead({ personId: person.id, title: `${name || email}${company ? " — " + company : ""}` });
      leadAction = "created";
    }

    await createFollowUpActivity({
      personId: person.id,
      leadId: lead?.id,
      subject: `${name || email} replied — follow up`,
    });

    res.status(200).json({
      ok: true,
      person_id: person.id,
      lead_id: lead?.id,
      lead_action: leadAction,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
};
