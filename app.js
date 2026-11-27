// Abnehm-Buddy – alles läuft im Browser. Daten: localStorage (Einträge) + IndexedDB (Fotos).
// KI: Google Gemini API (kostenloser Tarif), direkt aus dem Browser aufgerufen.
const APP_VERSION = "6 (27.11.2026)";
const GEMINI_URL = (model) => `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;

// ---------- Speicher ----------
const LS = {
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
    catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); }
    catch { toast("Speichern im Browser fehlgeschlagen"); }
  },
};

// Einträge: { "2026-11-27": { morning, evening, kcalIn, kcalSport, photoId } }
let entries = LS.get("ab_entries", {});
let persons = LS.get("ab_persons", []);
let feedback = LS.get("ab_feedback", []);
let settings = LS.get("ab_settings", {
  sex: "f", age: "", height: "", activity: "1.2", tdee: "",
  key: "", model: "gemini-3.8-flash", strict: "2", personaMode: "random",
});
if (String(settings.model).startsWith("claude")) settings.model = "gemini-3.8-flash";
// Für die Synchronisation: wann zuletzt geändert, welche Motivationsbilder gelöscht wurden
let personsAt = LS.get("ab_persons_at", 0);
let mDeleted = LS.get("ab_mdeleted", []);
let syncCfg = LS.get("ab_sync", { owner: "", repo: "abnehm-buddy-daten", token: "", last: null });
function touchPersons() { personsAt = Date.now(); LS.set("ab_persons", persons); LS.set("ab_persons_at", personsAt); scheduleSync(); }
function touchSettings() { settings.updatedAt = Date.now(); LS.set("ab_settings", settings); scheduleSync(); }

const DB_NAME = "abnehm-buddy";
function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("photos")) db.createObjectStore("photos");
      if (!db.objectStoreNames.contains("motivation")) db.createObjectStore("motivation");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function storePut(store, id, value) {
  const db = await openDb();
  return new Promise((res, rej) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).put(value, id);
    tx.oncomplete = res; tx.onerror = () => rej(tx.error);
  });
}
async function storeDelete(store, id) {
  const db = await openDb();
  return new Promise((res, rej) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).delete(id);
    tx.oncomplete = res; tx.onerror = () => rej(tx.error);
  });
}
async function storeGet(store, id) {
  if (!id) return null;
  const db = await openDb();
  return new Promise((res, rej) => {
    const req = db.transaction(store).objectStore(store).get(id);
    req.onsuccess = () => res(req.result || null); req.onerror = () => rej(req.error);
  });
}
async function storeAll(store) {
  const db = await openDb();
  return new Promise((res, rej) => {
    const out = {};
    const req = db.transaction(store).objectStore(store).openCursor();
    req.onsuccess = () => {
      const c = req.result;
      if (c) { out[c.key] = c.value; c.continue(); } else res(out);
    };
    req.onerror = () => rej(req.error);
  });
}
const photoPut = (id, v) => storePut("photos", id, v);
const photoGet = (id) => storeGet("photos", id);
const photoAll = () => storeAll("photos");

// ---------- Helfer ----------
const $ = (id) => document.getElementById(id);
const num = (v) => (v === "" || v == null || isNaN(Number(v)) ? null : Number(v));
const iso = (d) => d.toISOString().slice(0, 10);
const todayIso = () => iso(new Date(Date.now() - new Date().getTimezoneOffset() * 60000));
const addDays = (isoDate, n) => { const d = new Date(isoDate + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
const fmtDate = (isoDate) => new Date(isoDate + "T12:00:00").toLocaleDateString("de-DE", { weekday: "short", day: "2-digit", month: "2-digit" });
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function toast(msg) {
  const t = $("toast"); t.textContent = msg; t.classList.remove("hidden");
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.add("hidden"), 3500);
}

// Bild verkleinern (spart Speicher und KI-Kosten)
function resizeImage(file, maxSide = 1024) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
      const c = document.createElement("canvas");
      c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(img.src);
      resolve(c.toDataURL("image/jpeg", 0.85));
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

// ---------- Kalorien ----------
function baseNeed() {
  if (num(settings.tdee)) return num(settings.tdee);
  const w = latestWeight(), a = num(settings.age), h = num(settings.height);
  if (!w || !a || !h) return null;
  // Mifflin-St Jeor
  const bmr = 10 * w + 6.25 * h - 5 * a + (settings.sex === "m" ? 5 : -161);
  return Math.round(bmr * Number(settings.activity || 1.2));
}
function deficitOf(e) {
  const base = baseNeed();
  if (!e || base == null || num(e.kcalIn) == null) return null;
  return Math.round(base + (num(e.kcalSport) || 0) - num(e.kcalIn));
}
function rateDeficit(d) {
  if (d == null) return { cls: "", text: "Grundbedarf in den Einstellungen eintragen, dann wird das Defizit berechnet." };
  if (d >= 1000) return { cls: "super", label: "super", text: `Defizit ${d} kcal – super! 🔥` };
  if (d >= 700) return { cls: "gut", label: "gut", text: `Defizit ${d} kcal – gut. Ab 1000 ist es super.` };
  if (d > 0) return { cls: "schlecht", label: "zu wenig", text: `Defizit ${d} kcal – zu wenig. Ziel: mindestens 700.` };
  return { cls: "schlecht", label: "Überschuss", text: `Kein Defizit, sondern ${-d} kcal Überschuss.` };
}

// ---------- Gewicht & Trend ----------
function latestWeight() {
  const days = Object.keys(entries).sort().reverse();
  for (const d of days) { const w = num(entries[d].morning) ?? num(entries[d].evening); if (w) return w; }
  return null;
}
// Durchschnitt der Morgengewichte im Fenster [from, to]
function avgMorning(from, to) {
  const vals = Object.entries(entries)
    .filter(([d, e]) => d >= from && d <= to && num(e.morning))
    .map(([, e]) => num(e.morning));
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
}
// Vergleicht die letzten 3 Tage mit ca. 14 Tagen vorher (Morgengewicht, weil abends Wasser/Essen mitwiegt)
function trend(refDay) {
  const now = avgMorning(addDays(refDay, -2), refDay);
  const before = avgMorning(addDays(refDay, -17), addDays(refDay, -11));
  if (now == null || before == null) return null;
  const diff = +(now - before).toFixed(2);
  let kind = "stagnation";
  if (diff <= -0.3) kind = "loss";
  else if (diff >= 0.3) kind = "gain";
  return { now: +now.toFixed(1), before: +before.toFixed(1), diff, kind };
}
function photoNear(refDay, daysBack) {
  // Foto, das am nächsten an "refDay - daysBack" liegt (±5 Tage)
  const target = addDays(refDay, -daysBack);
  let best = null, bestDist = 99;
  for (const [d, e] of Object.entries(entries)) {
    if (!e.photoId || d === refDay) continue;
    const dist = Math.abs((new Date(d) - new Date(target)) / 86400000);
    if (dist <= 5 && dist < bestDist) { best = d; bestDist = dist; }
  }
  return best;
}

// ---------- KI ----------
function systemPrompt(p) {
  const strict = { "1": "sanft enttäuscht, aber liebevoll",
                   "2": "deutlich genervt und direkt, ohne Watte",
                   "3": "richtig sauer und laut (Großbuchstaben erlaubt), wie jemand, dem es echt nicht egal ist" }[settings.strict] || "deutlich";
  return `Du spielst ${p.name}, ${p.age ? p.age + " Jahre alt, " : ""}${p.rel ? p.rel + " der Person, mit der du schreibst" : "eine vertraute Person"}.
${p.style ? "So redet " + p.name + ": " + p.style : ""}
Du bist ihr Abnehm-Buddy und schreibst ihr eine kurze Nachricht (wie im Messenger, 2–5 Sätze, Deutsch, duzen), nachdem sie ihre Werte eingetragen hat.
Regeln:
- Abnahme im Vergleich zu vor ca. zwei Wochen oder sichtbarer Fortschritt auf den Fotos: richtig loben, konkret werden.
- Stagnation: motivieren weiterzumachen, erinnern, dass Plateaus normal sind, einen konkreten Tipp für morgen geben.
- Zunahme: ausschimpfen – Ton: ${strict}. Kritisiere das Verhalten (zu viel gegessen, Sport ausgelassen), nie ihren Körper, ihr Aussehen oder ihren Wert als Mensch. Ende mit einer klaren Ansage für morgen.
- Kaloriendefizit: ab 700 kcal gut, ab 1000 kcal super, je höher desto besser. Unter 700 ansprechen.
- Keine Gesundheitshinweise, keine Belehrungen, keine Warnungen vor zu großem Defizit – sie hat sich bewusst für diesen Weg entschieden.
- Bleib in der Rolle. Erwähne nicht, dass du eine KI bist.
- Wenn Fotos dabei sind: vergleiche ehrlich, erfinde keinen Fortschritt, den man nicht sieht.`;
}

function situationText(day) {
  const e = entries[day] || {};
  const t = trend(day);
  const d = deficitOf(e);
  const r = rateDeficit(d);
  const lines = [`Datum: ${day}`];
  if (num(e.morning)) lines.push(`Gewicht heute morgen: ${e.morning} kg`);
  if (num(e.evening)) lines.push(`Gewicht heute abend: ${e.evening} kg`);
  if (t) {
    const word = { loss: "ABNAHME", gain: "ZUNAHME", stagnation: "STAGNATION" }[t.kind];
    lines.push(`Trend: Ø morgens letzte 3 Tage ${t.now} kg, vor ca. zwei Wochen ${t.before} kg → ${t.diff > 0 ? "+" : ""}${t.diff} kg (${word})`);
  } else {
    // Fallback: gestern vs heute
    const y = entries[addDays(day, -1)];
    if (y && num(y.morning) && num(e.morning)) {
      const diff = +(num(e.morning) - num(y.morning)).toFixed(1);
      lines.push(`Noch keine zwei Wochen Daten. Gegenüber gestern: ${diff > 0 ? "+" : ""}${diff} kg (Tagesschwankung, nicht überbewerten)`);
    } else lines.push("Noch zu wenig Daten für einen Trend.");
  }
  if (num(e.kcalIn) != null) lines.push(`Gegessen: ${e.kcalIn} kcal, Sport: ${e.kcalSport || 0} kcal`);
  if (d != null) lines.push(`Defizit: ${d} kcal (${r.label})`);
  // Defizit-Schnitt der letzten 7 Tage
  const last7 = [...Array(7)].map((_, i) => deficitOf(entries[addDays(day, -i)])).filter((x) => x != null);
  if (last7.length > 1) lines.push(`Ø Defizit letzte ${last7.length} Tage: ${Math.round(last7.reduce((a, b) => a + b, 0) / last7.length)} kcal`);
  return lines.join("\n");
}

const imgPart = (dataUrl) => ({ inlineData: { mimeType: "image/jpeg", data: dataUrl.split(",")[1] } });
// Filter so weit runter wie möglich, damit Schimpfen erlaubt ist
const SAFETY_OFF = ["HARM_CATEGORY_HARASSMENT", "HARM_CATEGORY_HATE_SPEECH", "HARM_CATEGORY_SEXUALLY_EXPLICIT", "HARM_CATEGORY_DANGEROUS_CONTENT"]
  .map((category) => ({ category, threshold: "BLOCK_NONE" }));

class ApiError extends Error { constructor(msg, status) { super(msg); this.status = status; } }

// Alle Gratis-Modelle; das gewählte wird zuerst probiert, die anderen sind Ersatz bei Überlastung.
const ALL_MODELS = ["gemini-3.8-flash", "gemini-4-hydrogen", "gemini-3.6-flash", "gemini-3.5-flash-lite"];
const MODEL_NAMES = { "gemini-3.8-flash": "Gemini 3.8 Flash", "gemini-4-hydrogen": "Gemini 4 Hydrogen",
  "gemini-3.6-flash": "Gemini 3.6 Flash", "gemini-3.5-flash-lite": "Gemini 3.5 Flash-Lite" };
const modelName = (m) => MODEL_NAMES[m] || m;
const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const GEMINI_STREAM_URL = (model) => GEMINI_URL(model).replace(/:generateContent$/, ":streamGenerateContent?alt=sse");

// ---------- Statusanzeige beim Feedback ----------
const progress = {
  start: 0, timer: null,
  show() {
    this.start = Date.now(); $("fb-status").classList.remove("hidden", "error");
    this.step("Wird vorbereitet…");
    clearInterval(this.timer); this.tick(); this.timer = setInterval(() => this.tick(), 1000);
  },
  tick() { $("fb-elapsed").textContent = `${Math.round((Date.now() - this.start) / 1000)} s`; },
  step(txt) { $("fb-step").textContent = txt; },
  hide() { clearInterval(this.timer); $("fb-status").classList.add("hidden"); },
  fail(msg) { clearInterval(this.timer); this.step(msg); $("fb-status").classList.add("error"); },
};

// Ein Versuch bei einem Modell. Die Antwort kommt Stück für Stück (Streaming), onText bekommt den bisherigen Text.
async function geminiOnce(model, body, onText) {
  const ctrl = new AbortController();
  let timer;
  const arm = (ms) => { clearTimeout(timer); timer = setTimeout(() => ctrl.abort(), ms); };
  arm(30000); // 30 s ohne jedes Lebenszeichen → abbrechen und anderes Modell probieren
  let text = "", blockReason = null, finishReason = null;
  try {
    const res = await fetch(GEMINI_STREAM_URL(model), {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": settings.key },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new ApiError(data?.error?.message || `HTTP ${res.status}`, res.status);
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const handle = (line) => {
      line = line.trim();
      if (!line.startsWith("data:")) return;
      let chunk; try { chunk = JSON.parse(line.slice(5)); } catch { return; }
      if (chunk.error) throw new ApiError(chunk.error.message || "Fehler", chunk.error.code || 500);
      if (chunk.promptFeedback?.blockReason) blockReason = chunk.promptFeedback.blockReason;
      const cand = chunk.candidates?.[0];
      if (cand?.finishReason) finishReason = cand.finishReason;
      const piece = (cand?.content?.parts || []).filter((x) => x.text && !x.thought).map((x) => x.text).join("");
      if (piece) { text += piece; onText?.(text); }
    };
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      arm(30000);
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) { handle(buf.slice(0, nl)); buf = buf.slice(nl + 1); }
    }
    handle(buf);
    return { text: text.trim(), blockReason, finishReason };
  } catch (err) {
    if (text) return { text: text.trim(), blockReason, finishReason: "abgebrochen" }; // Teilantwort behalten
    if (err instanceof ApiError) throw err;
    throw new ApiError(err?.name === "AbortError" ? "Zeitüberschreitung" : "Keine Verbindung", 503);
  } finally {
    clearTimeout(timer);
  }
}

// Bei Überlastung (503 "high demand" u. ä.): erst kurz warten und wiederholen, dann auf ein anderes Modell ausweichen.
// report(text) meldet den aktuellen Schritt für diese Person.
async function callGemini(body, report, onText) {
  const order = [settings.model, ...ALL_MODELS.filter((m) => m !== settings.model)];
  let lastErr;
  for (let i = 0; i < order.length; i++) {
    const model = order[i];
    const tries = i === 0 ? 2 : 1;
    for (let t = 0; t < tries; t++) {
      try {
        report(`wartet auf ${modelName(model)}${t ? ` (Versuch ${t + 1})` : ""}…`);
        return await geminiOnce(model, body, onText);
      } catch (err) {
        lastErr = err;
        // Modell kennt die Einstellung für kurzes Nachdenken nicht → ohne sie nochmal
        if (err.status === 400 && /thinking/i.test(err.message) && body.generationConfig.thinkingConfig) {
          delete body.generationConfig.thinkingConfig; t--; continue;
        }
        if (err.status === 404) break;               // Modell gibt es nicht (mehr) → nächstes Modell
        if (!RETRYABLE.has(err.status)) throw err;    // z. B. Key ungültig → sofort abbrechen
        if (t < tries - 1) {
          report(`${modelName(model)} überlastet, neuer Versuch in 2 s…`);
          await sleep(2000);
        } else if (i < order.length - 1) {
          report(`${modelName(model)} überlastet, nehme ${modelName(order[i + 1])}…`);
        }
      }
    }
  }
  throw lastErr;
}

async function askPersona(p, day, report, onText) {
  const parts = [];
  const e = entries[day] || {};
  const oldDay = photoNear(day, 14);
  if (e.photoId) report("Fotos werden vorbereitet…");
  if (e.photoId && oldDay) {
    const [oldImg, newImg] = await Promise.all([photoGet(entries[oldDay].photoId), photoGet(e.photoId)]);
    if (oldImg && newImg) {
      parts.push({ text: `Foto vom ${oldDay}:` }, imgPart(oldImg));
      parts.push({ text: `Foto von heute (${day}):` }, imgPart(newImg));
    }
  } else if (e.photoId) {
    const img = await photoGet(e.photoId);
    if (img) parts.push({ text: "Heutiges Foto (noch kein Vergleichsfoto von vor zwei Wochen):" }, imgPart(img));
  }
  parts.push({ text: situationText(day) + "\n\nSchreib mir jetzt deine Nachricht." });

  const r = await callGemini({
    systemInstruction: { parts: [{ text: systemPrompt(p) }] },
    contents: [{ role: "user", parts }],
    safetySettings: SAFETY_OFF,
    // Kurze Messenger-Nachricht: kaum Nachdenken nötig, das spart viel Wartezeit
    generationConfig: { maxOutputTokens: 2048, thinkingConfig: { thinkingLevel: "low" } },
  }, report, onText);

  if (r.blockReason) return `(Google hat die Anfrage blockiert: ${r.blockReason}. Ohne Foto nochmal probieren.)`;
  if (!r.text) return `(Keine Antwort erhalten${r.finishReason ? ": " + r.finishReason : ""} – probier es nochmal.)`;
  return r.text;
}

function errorText(err) {
  const s = err?.status;
  return (s === 400 && /key/i.test(err.message)) || s === 401 || s === 403 ? "API-Key ungültig"
    : s === 404 ? "Modell nicht gefunden – in den Einstellungen ein anderes wählen"
    : s === 429 ? "Gratis-Kontingent erschöpft oder zu viele Anfragen – später nochmal"
    : s >= 500 ? "Gemini ist gerade überlastet – in ein paar Minuten nochmal probieren"
    : (err?.message || "Fehler bei der KI");
}

async function getFeedback(day) {
  if (!settings.key) { toast("Erst API-Key in den Einstellungen eintragen"); return; }
  if (!persons.length) { toast("Erst unter 'Personen' jemanden anlegen"); return; }
  const who = settings.personaMode === "all" ? persons : [persons[Math.floor(Math.random() * persons.length)]];
  const btn = $("feedback-btn"); btn.disabled = true; btn.textContent = "Läuft…";
  progress.show();
  $("fb-status").scrollIntoView({ behavior: "smooth", block: "nearest" });
  const list = $("feedback-list");
  if (!feedback.length) list.innerHTML = "";

  // Alle Personen gleichzeitig fragen, jede mit eigener Statuszeile und eigener Live-Sprechblase
  const jobs = who.map((p) => {
    const live = document.createElement("div");
    live.className = "bubble live";
    live.innerHTML = `<span class="who">${esc(p.name)}</span> <span class="when">· schreibt…</span><p></p>`;
    list.prepend(live);
    return { p, live, state: "startet…" };
  });
  const showStates = () => progress.step(jobs.map((j) => `${j.p.name}: ${j.state}`).join("\n"));
  const reattachLive = () => jobs.filter((j) => j.live.isConnected === false && !j.done).forEach((j) => list.prepend(j.live));
  showStates();

  const results = await Promise.allSettled(jobs.map(async (j) => {
    const report = (txt) => { j.state = txt; showStates(); };
    const onText = (t) => { j.live.querySelector("p").textContent = t; if (j.state !== "schreibt…") report("schreibt…"); };
    try {
      const text = await askPersona(j.p, day, report, onText);
      feedback.unshift({ at: new Date().toISOString(), day, who: j.p.name, text });
      LS.set("ab_feedback", feedback.slice(0, 200));
      j.state = "fertig ✓";
    } catch (err) {
      j.state = "✗ " + errorText(err);
      throw err;
    } finally {
      j.done = true; j.live.remove();
      renderFeedback(); reattachLive(); showStates();
    }
  }));

  const failed = results.filter((r) => r.status === "rejected");
  if (failed.length) console.error(...failed.map((r) => r.reason));
  if (failed.length < results.length) scheduleSync();
  if (!failed.length) progress.hide();
  else progress.fail(jobs.map((j) => `${j.p.name}: ${j.state}`).join("\n"));
  btn.disabled = false; btn.textContent = "Speichern + Feedback holen";
}

// ---------- Heute ----------
let pendingPhoto = null;

function loadDay(day) {
  const e = entries[day] || {};
  $("w-morning").value = e.morning ?? "";
  $("w-evening").value = e.evening ?? "";
  $("kcal-in").value = e.kcalIn ?? "";
  $("kcal-sport").value = e.kcalSport ?? "";
  $("today-label").textContent = fmtDate(day);
  pendingPhoto = null; $("photo-input").value = "";
  photoGet(e.photoId).then((src) => {
    const img = $("photo-preview");
    if (src) { img.src = src; img.classList.remove("hidden"); } else img.classList.add("hidden");
  });
  updateDeficit();
}
function currentFormEntry() {
  return { morning: num($("w-morning").value), evening: num($("w-evening").value),
           kcalIn: num($("kcal-in").value), kcalSport: num($("kcal-sport").value) };
}
function updateDeficit() {
  const r = rateDeficit(deficitOf(currentFormEntry()));
  const box = $("deficit-box"); box.className = "deficit " + r.cls; box.textContent = r.text;
}
async function saveDay() {
  const day = $("entry-date").value || todayIso();
  const e = { ...(entries[day] || {}), ...currentFormEntry() };
  if (pendingPhoto) {
    const id = "p_" + day + "_" + Date.now();
    await photoPut(id, pendingPhoto);
    e.photoId = id;
    pendingPhoto = null;
  }
  e.updatedAt = Date.now();
  entries[day] = e;
  LS.set("ab_entries", entries);
  renderAll();
  toast("Gespeichert");
  scheduleSync();
  return day;
}

// ---------- Rendering ----------
function renderFeedback() {
  $("feedback-list").innerHTML = feedback.length
    ? feedback.slice(0, 30).map((f) => `<div class="bubble"><span class="who">${esc(f.who)}</span>
        <span class="when">· ${new Date(f.at).toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short" })}</span>
        <p>${esc(f.text)}</p></div>`).join("")
    : `<p class="muted">Noch kein Feedback. Trag deine Werte ein und klick auf „Speichern + Feedback holen“.</p>`;
}

function renderChart() {
  const pts = Object.entries(entries).filter(([, e]) => num(e.morning)).sort(([a], [b]) => a.localeCompare(b)).slice(-60);
  const box = $("chart");
  if (pts.length < 2) { box.innerHTML = `<p class="muted">Ab zwei Morgenwerten erscheint hier eine Kurve.</p>`; $("trend-text").textContent = ""; return; }
  const W = 640, H = 220, P = 32;
  const vals = pts.map(([, e]) => num(e.morning));
  const min = Math.floor(Math.min(...vals) - 0.5), max = Math.ceil(Math.max(...vals) + 0.5);
  const x = (i) => P + (i * (W - 2 * P)) / (pts.length - 1);
  const y = (v) => H - P - ((v - min) * (H - 2 * P)) / (max - min || 1);
  const line = vals.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const dots = vals.map((v, i) => `<circle cx="${x(i)}" cy="${y(v)}" r="3" fill="var(--accent)"><title>${pts[i][0]}: ${v} kg</title></circle>`).join("");
  box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Gewichtsverlauf">
    <line x1="${P}" y1="${H - P}" x2="${W - P}" y2="${H - P}" stroke="var(--line)"/>
    <text x="4" y="${y(max) + 4}" font-size="11" fill="var(--muted)">${max}</text>
    <text x="4" y="${y(min) + 4}" font-size="11" fill="var(--muted)">${min}</text>
    <text x="${P}" y="${H - 8}" font-size="11" fill="var(--muted)">${fmtDate(pts[0][0])}</text>
    <text x="${W - P}" y="${H - 8}" font-size="11" fill="var(--muted)" text-anchor="end">${fmtDate(pts.at(-1)[0])}</text>
    <path d="${line}" fill="none" stroke="var(--accent)" stroke-width="2"/>${dots}</svg>`;
  const t = trend(pts.at(-1)[0]);
  $("trend-text").textContent = t
    ? `Ø letzte 3 Tage ${t.now} kg vs. vor ~2 Wochen ${t.before} kg: ${t.diff > 0 ? "+" : ""}${t.diff} kg`
    : "Für den Zwei-Wochen-Vergleich braucht es mindestens 2 Wochen Morgenwerte.";
}

function renderTable() {
  const days = Object.keys(entries).sort().reverse();
  $("entries-table").innerHTML = `<tr><th>Tag</th><th>Morgens</th><th>Abends</th><th>Gegessen</th><th>Sport</th><th>Defizit</th><th></th></tr>` +
    days.map((d) => {
      const e = entries[d], def = deficitOf(e), r = rateDeficit(def);
      return `<tr><td>${fmtDate(d)}</td><td>${e.morning ?? "–"}</td><td>${e.evening ?? "–"}</td>
        <td>${e.kcalIn ?? "–"}</td><td>${e.kcalSport ?? "–"}</td>
        <td class="deficit ${r.cls}" style="background:none;padding:6px 8px">${def ?? "–"}</td>
        <td><button data-edit="${d}">Bearbeiten</button></td></tr>`;
    }).join("");
}

async function renderPhotos() {
  const all = await photoAll();
  const items = Object.entries(entries).filter(([, e]) => e.photoId && all[e.photoId]).sort(([a], [b]) => b.localeCompare(a));
  $("photo-grid").innerHTML = items.length
    ? items.map(([d, e]) => `<figure><img src="${all[e.photoId]}" alt="Foto vom ${d}"><figcaption>${fmtDate(d)}${e.morning ? " · " + e.morning + " kg" : ""}</figcaption></figure>`).join("")
    : `<p class="muted">Noch keine Fotos.</p>`;
}

function renderPersons() {
  $("persons-list").innerHTML = persons.length
    ? persons.map((p, i) => `<div class="person"><div><strong>${esc(p.name)}</strong>
        <span class="muted">${p.age ? esc(p.age) + " J. · " : ""}${esc(p.rel)}</span>
        ${p.style ? `<div class="muted">${esc(p.style)}</div>` : ""}</div>
        <div class="person-btns"><button data-edit="${i}">Bearbeiten</button>
        <button data-del="${i}">Entfernen</button></div></div>`).join("")
    : `<p class="muted">Noch niemand angelegt.</p>`;
  $("persona-mode").value = settings.personaMode || "random";
}

function renderSettings() {
  for (const k of ["sex", "age", "height", "activity", "tdee", "key", "model", "strict"]) $("s-" + k).value = settings[k] ?? "";
  const b = baseNeed();
  $("tdee-info").textContent = b ? `Dein Grundbedarf ohne Sport: ca. ${b} kcal/Tag` : "Alter, Größe und ein Gewicht eintragen, dann wird der Grundbedarf berechnet.";
}

// ---------- Motivationsbilder & Diashow ----------
// Eintrag im Store "motivation": { src, caption, added }
let slides = [], slideIdx = 0, slideTimer = null, slidePaused = false;
const SLIDE_MS = 6000;

// Reihenfolge pro Tag fest, jeden Tag neu gemischt
function dailyShuffle(arr, seedStr) {
  let seed = [...seedStr].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
  return out;
}

function showSlide(i) {
  if (!slides.length) return;
  slideIdx = (i + slides.length) % slides.length;
  const s = slides[slideIdx], img = $("slide-img");
  img.classList.add("fading");
  setTimeout(() => {
    img.src = s.src;
    $("slide-caption").textContent = s.caption || "";
    $("slide-count").textContent = `${slideIdx + 1} / ${slides.length}`;
    img.classList.remove("fading");
  }, slides.length > 1 ? 200 : 0);
}
function restartSlideTimer() {
  clearInterval(slideTimer);
  if (!slidePaused && slides.length > 1) slideTimer = setInterval(() => showSlide(slideIdx + 1), SLIDE_MS);
}

async function renderMotivation() {
  const all = await storeAll("motivation");
  const items = Object.entries(all).map(([id, v]) => ({ id, ...v })).sort((a, b) => a.added.localeCompare(b.added));
  $("m-grid").innerHTML = items.length
    ? items.map((m) => `<figure><img src="${m.src}" alt="${esc(m.caption || "Motivationsbild")}">
        <button class="del" data-mdel="${esc(m.id)}" aria-label="Bild löschen">✕</button>
        <figcaption>${esc(m.caption || "")}</figcaption></figure>`).join("")
    : `<p class="muted">Noch keine Bilder.</p>`;

  slides = dailyShuffle(items, todayIso());
  $("slideshow-card").classList.toggle("hidden", !slides.length);
  $("slide-pause").classList.toggle("hidden", slides.length < 2);
  $("slide-prev").classList.toggle("hidden", slides.length < 2);
  $("slide-next").classList.toggle("hidden", slides.length < 2);
  if (slides.length) showSlide(Math.min(slideIdx, slides.length - 1));
  restartSlideTimer();
}

function renderAll() { renderFeedback(); renderChart(); renderTable(); renderPhotos(); renderPersons(); renderSettings(); renderMotivation(); updateDeficit(); }

// ---------- Events ----------
document.querySelectorAll("nav button").forEach((b) => b.addEventListener("click", () => {
  document.querySelectorAll("nav button").forEach((x) => x.classList.toggle("active", x === b));
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.id === "tab-" + b.dataset.tab));
}));

// Leeres Datum (gelöscht oder unvollständig) → zurück auf heute, sonst zeigt der Browser nur "TT.MM.JJJJ"
const fixEmptyDate = () => { if (!$("entry-date").value) { $("entry-date").value = todayIso(); loadDay(todayIso()); } };
$("entry-date").addEventListener("change", (ev) => { if (ev.target.value) loadDay(ev.target.value); else fixEmptyDate(); });
$("entry-date").addEventListener("blur", fixEmptyDate);
["w-morning", "w-evening", "kcal-in", "kcal-sport"].forEach((id) => $(id).addEventListener("input", updateDeficit));

$("photo-input").addEventListener("change", async (ev) => {
  const f = ev.target.files[0]; if (!f) return;
  pendingPhoto = await resizeImage(f);
  const img = $("photo-preview"); img.src = pendingPhoto; img.classList.remove("hidden");
});

$("m-input").addEventListener("change", async (ev) => {
  const files = [...ev.target.files]; if (!files.length) return;
  const caption = $("m-caption").value.trim();
  for (const [i, f] of files.entries()) {
    try {
      const src = await resizeImage(f, 1280);
      await storePut("motivation", `m_${Date.now()}_${i}`, { src, caption, added: new Date().toISOString() });
    } catch { toast(`${f.name} konnte nicht geladen werden`); }
  }
  ev.target.value = ""; $("m-caption").value = "";
  await renderMotivation();
  toast(files.length === 1 ? "Bild hinzugefügt" : `${files.length} Bilder hinzugefügt`);
  scheduleSync();
});
$("m-grid").addEventListener("click", async (ev) => {
  const id = ev.target.dataset.mdel; if (!id) return;
  await storeDelete("motivation", id);
  mDeleted.push(id); LS.set("ab_mdeleted", mDeleted);
  renderMotivation();
  scheduleSync();
});
$("slide-prev").addEventListener("click", () => { showSlide(slideIdx - 1); restartSlideTimer(); });
$("slide-next").addEventListener("click", () => { showSlide(slideIdx + 1); restartSlideTimer(); });
$("slide-pause").addEventListener("click", () => {
  slidePaused = !slidePaused;
  $("slide-pause").textContent = slidePaused ? "▶︎ Weiter" : "⏸";
  $("slide-pause").setAttribute("aria-label", slidePaused ? "Weiter" : "Pause");
  restartSlideTimer();
});

$("save-btn").addEventListener("click", saveDay);
$("feedback-btn").addEventListener("click", async () => { const day = await saveDay(); await getFeedback(day); });

$("entries-table").addEventListener("click", (ev) => {
  const d = ev.target.dataset.edit; if (!d) return;
  $("entry-date").value = d; loadDay(d);
  document.querySelector('nav button[data-tab="heute"]').click();
});

let editingPerson = null; // Index der Person, die gerade bearbeitet wird, sonst null
function resetPersonForm() {
  editingPerson = null;
  ["p-name", "p-age", "p-rel", "p-style"].forEach((id) => ($(id).value = ""));
  $("p-form-title").textContent = "Person hinzufügen";
  $("p-add").textContent = "Hinzufügen";
  $("p-cancel").classList.add("hidden");
}
$("p-add").addEventListener("click", () => {
  const name = $("p-name").value.trim();
  if (!name) { toast("Name fehlt"); return; }
  const p = { name, age: $("p-age").value.trim(), rel: $("p-rel").value.trim(), style: $("p-style").value.trim() };
  const wasEdit = editingPerson != null && persons[editingPerson];
  if (wasEdit) persons[editingPerson] = { ...persons[editingPerson], ...p };
  else persons.push(p);
  touchPersons();
  resetPersonForm();
  renderPersons(); toast(wasEdit ? name + " gespeichert" : name + " hinzugefügt");
});
$("p-cancel").addEventListener("click", resetPersonForm);
$("persons-list").addEventListener("click", (ev) => {
  const { del, edit } = ev.target.dataset;
  if (edit != null) {
    const p = persons[Number(edit)]; if (!p) return;
    editingPerson = Number(edit);
    $("p-name").value = p.name || ""; $("p-age").value = p.age || "";
    $("p-rel").value = p.rel || ""; $("p-style").value = p.style || "";
    $("p-form-title").textContent = `${p.name} bearbeiten`;
    $("p-add").textContent = "Änderungen speichern";
    $("p-cancel").classList.remove("hidden");
    $("p-form-title").scrollIntoView({ behavior: "smooth", block: "start" });
    $("p-name").focus({ preventScroll: true });
    return;
  }
  if (del == null) return;
  const p = persons[Number(del)];
  if (p && !confirm(`${p.name} wirklich entfernen?`)) return;
  persons.splice(Number(del), 1);
  if (editingPerson != null) resetPersonForm();
  touchPersons(); renderPersons();
});
$("persona-mode").addEventListener("change", (ev) => { settings.personaMode = ev.target.value; touchSettings(); });

$("settings-save").addEventListener("click", () => {
  for (const k of ["sex", "age", "height", "activity", "tdee", "key", "model", "strict"]) settings[k] = $("s-" + k).value.trim();
  touchSettings(); renderSettings(); updateDeficit(); toast("Einstellungen gespeichert");
});

$("export-btn").addEventListener("click", async () => {
  const data = { entries, persons, feedback, settings: { ...settings, key: "" }, photos: await photoAll(), motivation: await storeAll("motivation") };
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: "application/json" }));
  a.download = `abnehm-buddy-backup-${todayIso()}.json`; a.click();
});
$("import-input").addEventListener("change", async (ev) => {
  const f = ev.target.files[0]; if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    entries = data.entries || {}; persons = data.persons || []; feedback = data.feedback || [];
    settings = { ...settings, ...(data.settings || {}), key: settings.key };
    for (const [id, src] of Object.entries(data.photos || {})) await photoPut(id, src);
    for (const [id, m] of Object.entries(data.motivation || {})) await storePut("motivation", id, m);
    // Geladenes Backup gilt als neuester Stand
    const now = Date.now();
    for (const d of Object.keys(entries)) entries[d].updatedAt = now;
    LS.set("ab_entries", entries); LS.set("ab_feedback", feedback);
    touchPersons(); touchSettings();
    loadDay($("entry-date").value); renderAll(); toast("Backup geladen");
  } catch { toast("Backup-Datei ist ungültig"); }
});

// ---------- Synchronisation über ein privates GitHub-Repo ----------
// Aufbau im Daten-Repo:  data.json  +  photos/<id>.jpg  +  motivation/<id>.jpg
// Zusammenführen: pro Tag gewinnt der zuletzt geänderte Eintrag; Personen und Einstellungen als Ganzes;
// Feedback wird vereinigt. API-Keys und der Token selbst werden nie hochgeladen.
const SYNC_SETTING_KEYS = ["sex", "age", "height", "activity", "tdee", "model", "strict", "personaMode"];
let syncRunning = false, syncQueued = false, syncTimer = null, lastVisibleSync = 0;

class SyncError extends Error { constructor(status, msg) { super(msg || `HTTP ${status}`); this.status = status; } }
const syncReady = () => syncCfg.owner && syncCfg.repo && syncCfg.token;

function utf8ToB64(s) {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
function b64ToUtf8(b64) {
  const bin = atob(b64.replace(/\s/g, ""));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}
function blobToDataUrl(blob) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(blob); });
}

function gh(path, opts = {}) {
  const url = `https://api.github.com/repos/${encodeURIComponent(syncCfg.owner)}/${encodeURIComponent(syncCfg.repo)}/contents/${path}`;
  return fetch(url, {
    ...opts,
    cache: "no-store",
    headers: {
      Authorization: `Bearer ${syncCfg.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(opts.headers || {}),
    },
  });
}
async function ghGetJson(path) {
  const r = await gh(path);
  if (r.status === 404) return { data: null, sha: null };
  if (!r.ok) throw new SyncError(r.status);
  const meta = await r.json();
  let text;
  if (meta.encoding === "base64" && meta.content) text = b64ToUtf8(meta.content);
  else { // Dateien über 1 MB liefert die API nur roh
    const raw = await gh(path, { headers: { Accept: "application/vnd.github.raw+json" } });
    if (!raw.ok) throw new SyncError(raw.status);
    text = await raw.text();
  }
  return { data: JSON.parse(text), sha: meta.sha };
}
async function ghPut(path, b64, sha, message) {
  const r = await gh(path, { method: "PUT", body: JSON.stringify({ message, content: b64, ...(sha ? { sha } : {}) }) });
  if (!r.ok) throw new SyncError(r.status);
}
async function ghList(dir) {
  const r = await gh(dir);
  if (r.status === 404) return new Set();
  if (!r.ok) throw new SyncError(r.status);
  const list = await r.json();
  return new Set(Array.isArray(list) ? list.map((f) => f.name) : []);
}
async function ghGetImage(path) {
  const r = await gh(path, { headers: { Accept: "application/vnd.github.raw+json" } });
  if (!r.ok) throw new SyncError(r.status);
  return blobToDataUrl(new Blob([await r.blob()], { type: "image/jpeg" }));
}

function mergeRemote(remote) {
  const r = remote || {};
  for (const [d, re] of Object.entries(r.entries || {})) {
    const le = entries[d];
    if (!le || (re.updatedAt || 0) > (le.updatedAt || 0)) entries[d] = re;
  }
  if ((r.personsAt || 0) > personsAt) { persons = r.persons || []; personsAt = r.personsAt; }
  if ((r.settings?.updatedAt || 0) > (settings.updatedAt || 0)) {
    for (const k of SYNC_SETTING_KEYS) if (k in r.settings) settings[k] = r.settings[k];
    settings.updatedAt = r.settings.updatedAt;
  }
  const seen = new Set(feedback.map((f) => f.at + "|" + f.who));
  for (const f of r.feedback || []) if (!seen.has(f.at + "|" + f.who)) feedback.push(f);
  feedback.sort((a, b) => b.at.localeCompare(a.at));
  feedback = feedback.slice(0, 200);
  mDeleted = [...new Set([...mDeleted, ...(r.mDeleted || [])])];

  LS.set("ab_entries", entries); LS.set("ab_persons", persons); LS.set("ab_persons_at", personsAt);
  LS.set("ab_settings", settings); LS.set("ab_feedback", feedback); LS.set("ab_mdeleted", mDeleted);
}

function setSyncStatus(text, isError = false) {
  const el = $("sync-status");
  if (el) { el.textContent = text; el.style.color = isError ? "var(--bad)" : ""; }
  const badge = $("sync-badge");
  if (badge) badge.textContent = syncReady() ? (isError ? "⚠ Sync" : syncRunning ? "↻ Sync…" : "✓ Sync") : "";
}

async function runSync(attempt = 0) {
  const dayShown = $("entry-date").value;
  const before = JSON.stringify(entries[dayShown] || null);

  // 1. Stand vom Server holen und zusammenführen
  const { data: remote, sha } = await ghGetJson("data.json");
  mergeRemote(remote);

  // 2. Motivationsbilder: Gelöschte entfernen, fehlende holen
  const localM = await storeAll("motivation");
  for (const id of mDeleted) if (localM[id]) { await storeDelete("motivation", id); delete localM[id]; }
  const [remotePhotos, remoteM] = await Promise.all([ghList("photos"), ghList("motivation")]);
  for (const [id, meta] of Object.entries(remote?.motivation || {})) {
    if (localM[id] || mDeleted.includes(id) || !remoteM.has(id + ".jpg")) continue;
    const src = await ghGetImage(`motivation/${id}.jpg`);
    localM[id] = { ...meta, src };
    await storePut("motivation", id, localM[id]);
  }
  for (const [id, m] of Object.entries(localM)) {
    if (!remoteM.has(id + ".jpg")) await ghPut(`motivation/${id}.jpg`, m.src.split(",")[1], null, "Motivationsbild");
  }

  // 3. Tagesfotos: fehlende holen bzw. hochladen
  const localP = await photoAll();
  for (const e of Object.values(entries)) {
    const id = e.photoId; if (!id) continue;
    if (!localP[id] && remotePhotos.has(id + ".jpg")) { localP[id] = await ghGetImage(`photos/${id}.jpg`); await photoPut(id, localP[id]); }
    else if (localP[id] && !remotePhotos.has(id + ".jpg")) await ghPut(`photos/${id}.jpg`, localP[id].split(",")[1], null, "Foto");
  }

  // 4. Zusammengeführten Stand hochladen
  const out = {
    version: 1, savedAt: new Date().toISOString(),
    entries, persons, personsAt, feedback, mDeleted,
    settings: Object.fromEntries([...SYNC_SETTING_KEYS, "updatedAt"].map((k) => [k, settings[k]])),
    motivation: Object.fromEntries(Object.entries(localM).map(([id, m]) => [id, { caption: m.caption || "", added: m.added }])),
  };
  try {
    await ghPut("data.json", utf8ToB64(JSON.stringify(out)), sha, "Sync " + out.savedAt);
  } catch (err) {
    // Anderes Gerät war schneller → nochmal von vorn
    if ((err.status === 409 || err.status === 422) && attempt < 2) return runSync(attempt + 1);
    throw err;
  }

  renderAll();
  if (JSON.stringify(entries[dayShown] || null) !== before) loadDay(dayShown);
}

async function syncNow() {
  if (!syncReady()) return;
  if (syncRunning) { syncQueued = true; return; }
  syncRunning = true; setSyncStatus("Synchronisiere…");
  try {
    await runSync();
    syncCfg.last = new Date().toISOString(); LS.set("ab_sync", syncCfg);
    syncRunning = false;
    setSyncStatus("Zuletzt synchronisiert: " + new Date(syncCfg.last).toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short" }));
  } catch (err) {
    console.error(err);
    syncRunning = false;
    const s = err.status;
    setSyncStatus(
      s === 401 ? "Sync fehlgeschlagen: Token ungültig oder abgelaufen."
      : s === 403 ? "Sync fehlgeschlagen: Der Token darf nicht schreiben (Contents: Read and write freigeben)."
      : s === 404 ? "Sync fehlgeschlagen: Repo nicht gefunden. Benutzername, Repo-Name und Token-Freigabe prüfen."
      : !navigator.onLine ? "Offline – wird synchronisiert, sobald du wieder Internet hast."
      : "Sync fehlgeschlagen: " + err.message, true);
  }
  if (syncQueued) { syncQueued = false; syncNow(); }
}
function scheduleSync() {
  if (!syncReady()) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(syncNow, 1500);
}

function renderSyncSettings() {
  $("sync-repo").value = syncCfg.repo || "abnehm-buddy-daten";
  $("sync-token").value = syncCfg.token || "";
  setSyncStatus(syncReady()
    ? (syncCfg.last ? "Zuletzt synchronisiert: " + new Date(syncCfg.last).toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short" }) : "Noch nicht synchronisiert.")
    : "Nicht eingerichtet – Daten bleiben nur auf diesem Gerät.");
}
$("sync-save").addEventListener("click", async () => {
  const token = $("sync-token").value.trim();
  const repo = $("sync-repo").value.trim() || "abnehm-buddy-daten";
  if (!token) { setSyncStatus("Bitte den Schlüssel eintragen.", true); return; }
  setSyncStatus("Prüfe Schlüssel…");
  try {
    // Benutzername aus dem Schlüssel ermitteln
    const r = await fetch("https://api.github.com/user", {
      cache: "no-store",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
    });
    if (!r.ok) { setSyncStatus(r.status === 401 ? "Schlüssel ungültig oder abgelaufen." : `Schlüssel konnte nicht geprüft werden (HTTP ${r.status}).`, true); return; }
    syncCfg = { ...syncCfg, owner: (await r.json()).login, repo, token };
    LS.set("ab_sync", syncCfg);
    syncNow();
  } catch { setSyncStatus("Keine Verbindung zu GitHub.", true); }
});
$("sync-off").addEventListener("click", () => {
  syncCfg = { owner: "", repo: syncCfg.repo, token: "", last: null };
  LS.set("ab_sync", syncCfg); renderSyncSettings(); setSyncStatus("Sync auf diesem Gerät ausgeschaltet. Deine Daten hier bleiben erhalten.");
});
$("sync-now").addEventListener("click", syncNow);
// Wenn du die Seite wieder öffnest (z. B. App-Wechsel am Handy), neuen Stand holen
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && Date.now() - lastVisibleSync > 30000) { lastVisibleSync = Date.now(); syncNow(); }
});
window.addEventListener("online", () => scheduleSync());

// ---------- Start ----------
$("app-version").textContent = "Version " + APP_VERSION;
$("entry-date").value = todayIso();
loadDay(todayIso());
renderAll();
renderSyncSettings();
if (syncReady()) { lastVisibleSync = Date.now(); syncNow(); }
