/**
 * Sunday Run Club — Railway Server
 * Receives webhook from Google Sheets, verifies screenshot,
 * calculates points, saves to Supabase, writes result back to Sheet.
 */

import express from "express";
import { createClient } from "@supabase/supabase-js";

const app  = express();
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const WEBHOOK_SECRET     = process.env.WEBHOOK_SECRET;
const ANTHROPIC_API_KEY  = process.env.ANTHROPIC_API_KEY;
const GOOGLE_SERVICE_KEY = JSON.parse(process.env.GOOGLE_SERVICE_KEY_JSON || "{}");

// ── POINTS ENGINE ─────────────────────────────────────────────
const TIERS = {
  running:  [[10,10],[20,12],[30,14],[Infinity,16]],
  walking:  [[10,5],[20,6],[30,7],[Infinity,8]],
  hiking:   [[10,5],[20,6],[30,7],[Infinity,8]],   // same as walking
  swimming: [[2,15],[5,18],[Infinity,21]],
  cycling:  [[20,3],[50,4],[Infinity,5]],
  rowing:   [[5,8],[15,10],[Infinity,12]],
};
// Flat-rate activities: points per session regardless of duration/distance
const FLAT = {
  "gym / workout":       50,
  "yoga":                40,
  "badminton":           45,
  "football":            45,
  "basketball":          45,
  "cricket":             40,
  "skipping / jump rope":35,
  "martial arts":        45,
  "dance / zumba":       35,
};

function calcPoints(type, distanceKm, activityDate) {
  const t = type.toLowerCase().trim();
  let base = 0, breakdown = [];

  if (FLAT[t] !== undefined) {
    base = FLAT[t];
  } else if (TIERS[t]) {
    let rem = distanceKm, prev = 0;
    for (const [ceil, rate] of TIERS[t]) {
      if (rem <= 0) break;
      const km  = Math.min(rem, ceil - prev);
      const pts = km * rate;
      base += pts;
      breakdown.push({ from: prev, to: Math.min(distanceKm, ceil), km: +km.toFixed(2), rate, pts: Math.round(pts) });
      rem -= km; prev = ceil;
    }
    base = Math.round(base);
  }

  const bonuses = [];
  if (activityDate) {
    const hour = new Date(activityDate).getHours();
    if (hour < 7) bonuses.push({ pts: 10, reason: "Early bird (before 7 AM)" });
  }

  const bonusTotal = bonuses.reduce((s, b) => s + b.pts, 0);
  return { total: base + bonusTotal, base, breakdown, bonuses };
}

// ── GET GOOGLE ACCESS TOKEN (for writing back to Sheet) ───────
async function getGoogleToken() {
  const { privateKey, clientEmail } = GOOGLE_SERVICE_KEY;
  if (!privateKey) return null;

  const now  = Math.floor(Date.now() / 1000);
  const claim = {
    iss: clientEmail,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600, iat: now,
  };

  // Build JWT (simple, no external library needed)
  const header  = btoa(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = btoa(JSON.stringify(claim));
  const unsigned = `${header}.${payload}`;

  // Sign with private key using Web Crypto
  const pemKey  = privateKey.replace(/\\n/g, "\n");
  const keyData = pemKey.replace(/-----.*?-----/g, "").replace(/\s/g, "");
  const binaryKey = Uint8Array.from(atob(keyData), c => c.charCodeAt(0));

  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8", binaryKey,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false, ["sign"]
  );

  const encoder  = new TextEncoder();
  const sigBytes = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", cryptoKey, encoder.encode(unsigned));
  const sig      = btoa(String.fromCharCode(...new Uint8Array(sigBytes)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");

  const jwt = `${unsigned}.${sig}`;

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });
  const data = await tokenRes.json();
  return data.access_token || null;
}

// ── WRITE RESULT BACK TO SHEET ────────────────────────────────
async function writeBackToSheet(spreadsheetId, sheetName, rowNumber, status, points) {
  try {
    const token = await getGoogleToken();
    if (!token) return;

    const range  = `${sheetName}!J${rowNumber}:L${rowNumber}`;
    const values = [[status, points, new Date().toISOString()]];

    await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`,
      {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ range, majorDimension: "ROWS", values }),
      }
    );
  } catch (err) {
    console.error("Sheet write-back failed:", err.message);
  }
}

// ── AI SCREENSHOT VERIFICATION ────────────────────────────────
async function verifyScreenshot(screenshotUrl, submittedData) {
  if (!screenshotUrl || !screenshotUrl.startsWith("http")) {
    return { valid: false, confidence: 0, notes: "No screenshot provided or invalid URL" };
  }

  // Convert Google Drive share URL to direct download URL
  let imageUrl = screenshotUrl;
  const driveMatch = screenshotUrl.match(/\/d\/([a-zA-Z0-9_-]+)/);
  if (driveMatch) {
    imageUrl = `https://drive.google.com/uc?export=download&id=${driveMatch[1]}`;
  }

  try {
    // Fetch the image
    const imgRes = await fetch(imageUrl);
    if (!imgRes.ok) throw new Error(`Image fetch failed: ${imgRes.status}`);

    const buffer   = await imgRes.arrayBuffer();
    const base64   = Buffer.from(buffer).toString("base64");
    const mimeType = imgRes.headers.get("content-type") || "image/jpeg";

    // Ask Claude to verify it
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 500,
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mimeType, data: base64 } },
            {
              type: "text",
              text: `This screenshot was submitted for a fitness challenge. The participant claims:
- Activity: ${submittedData.activity_type}
- Distance: ${submittedData.distance_km} km
- Duration: ${submittedData.duration}
- Date: ${submittedData.activity_date}

Verify this screenshot. Respond ONLY with valid JSON, no markdown:
{
  "is_fitness_screenshot": true or false,
  "activity_type_matches": true, false, or "cannot_verify",
  "distance_matches": true, false, or "cannot_verify",
  "looks_legitimate": true or false,
  "confidence": 0-100,
  "notes": "brief note — flag anything suspicious or unclear"
}`
            }
          ]
        }]
      })
    });

    const data = await res.json();
    const raw  = data.content?.map(b => b.text || "").join("") || "{}";
    const result = JSON.parse(raw.replace(/```json|```/g, "").trim());

    const valid = result.is_fitness_screenshot &&
                  result.looks_legitimate &&
                  result.activity_type_matches !== false;

    return { valid, confidence: result.confidence || 50, notes: result.notes || "" };

  } catch (err) {
    console.error("Screenshot verification error:", err.message);
    // On error, allow with low confidence — admin can review
    return { valid: true, confidence: 30, notes: `Could not verify: ${err.message}` };
  }
}

// ── WEBHOOK ENDPOINT ──────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  // Respond to Apps Script immediately so it doesn't time out
  res.status(200).json({ received: true });

  const data = req.body;

  // Validate secret
  if (data.secret !== WEBHOOK_SECRET) {
    console.warn("Invalid webhook secret");
    return;
  }

  console.log(`Processing: ${data.name} — ${data.activity_type} ${data.distance_km}km`);

  try {
    // 1. Look up athlete in DB
    const { data: athlete } = await supabase
      .from("athletes")
      .select("id, name, team_id")
      .ilike("name", data.name.trim())
      .single();

    if (!athlete) {
      console.warn(`Unknown athlete: ${data.name}`);
      await writeBackToSheet(data.spreadsheet_id, data.sheet_name, data.row_number,
        "⚠ Name not found — contact admin", 0);
      return;
    }

    // 2. Verify screenshot
    const verification = await verifyScreenshot(data.screenshot_url, data);

    // 3. Calculate points
    const points = calcPoints(data.activity_type, data.distance_km, data.activity_date);

    // 4. Determine status
    let status = "approved";
    if (!verification.valid)       status = "flagged";
    if (verification.confidence < 50) status = "pending_review";

    // 5. Save to Supabase
    const { error: dbErr } = await supabase.from("activities").insert({
      athlete_id:          athlete.id,
      type:                data.activity_type.toLowerCase().trim(),
      distance_km:         data.distance_km,
      duration_text:       data.duration,
      activity_date:       data.activity_date || null,
      notes:               data.notes,
      screenshot_url:      data.screenshot_url,
      ai_confidence:       verification.confidence,
      ai_notes:            verification.notes,
      review_status:       status,
      points:              status === "approved" ? points.total : 0,
      points_breakdown:    points,
      source_row:          data.row_number,
      spreadsheet_id:      data.spreadsheet_id,
    });

    if (dbErr) throw dbErr;

    // 6. Write result back to the Google Sheet
    const statusLabel = status === "approved"
      ? "✅ Approved"
      : status === "flagged"
        ? "🚩 Flagged — screenshot issue"
        : "🔍 Pending review";

    await writeBackToSheet(
      data.spreadsheet_id, data.sheet_name, data.row_number,
      statusLabel,
      status === "approved" ? points.total : "—"
    );

    console.log(`✓ ${data.name}: ${points.total} pts (${status})`);

  } catch (err) {
    console.error("Processing error:", err.message);
    await writeBackToSheet(data.spreadsheet_id, data.sheet_name, data.row_number,
      "⚠ Error — contact admin", 0);
  }
});

// ── HEALTH CHECK ──────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ status: "SRC server running", time: new Date().toISOString() });
});

// ── ADMIN: manual re-review endpoint ─────────────────────────
app.post("/approve/:id", async (req, res) => {
  if (req.headers["x-admin-key"] !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const { error } = await supabase
    .from("activities")
    .update({ review_status: "approved" })
    .eq("id", req.params.id);
  res.json({ ok: !error, error: error?.message });
});

app.listen(process.env.PORT || 3000, () => {
  console.log("SRC server listening on port", process.env.PORT || 3000);
});
