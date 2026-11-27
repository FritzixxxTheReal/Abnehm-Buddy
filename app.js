// Abnehm-Buddy – alles läuft im Browser. Daten: localStorage (Einträge) + IndexedDB (Fotos).
// KI: Google Gemini API (kostenloser Tarif), direkt aus dem Browser aufgerufen.
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

async function askPersona(p, day) {
  const parts = [];
  const e = entries[day] || {};
  const oldDay = photoNear(day, 14);
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

  const res = await fetch(GEMINI_URL(settings.model), {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": settings.key },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt(p) }] },
      contents: [{ role: "user", parts }],
      safetySettings: SAFETY_OFF,
      generationConfig: { maxOutputTokens: 4096 },
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data?.error?.message || `HTTP ${res.status}`, res.status);

  if (data.promptFeedback?.blockReason) return `(Google hat die Anfrage blockiert: ${data.promptFeedback.blockReason}. Ohne Foto nochmal probieren.)`;
  const cand = data.candidates?.[0];
  const text = (cand?.content?.parts || []).filter((x) => x.text && !x.thought).map((x) => x.text).join("").trim();
  if (!text) return `(Keine Antwort erhalten${cand?.finishReason ? ": " + cand.finishReason : ""} – probier es nochmal.)`;
  return text;
}

async function getFeedback(day) {
  if (!settings.key) { toast("Erst API-Key in den Einstellungen eintragen"); return; }
  if (!persons.length) { toast("Erst unter 'Personen' jemanden anlegen"); return; }
  const who = settings.personaMode === "all" ? persons : [persons[Math.floor(Math.random() * persons.length)]];
  const btn = $("feedback-btn"); btn.disabled = true; btn.textContent = "Schreibt…";
  try {
    for (const p of who) {
      const text = await askPersona(p, day);
      feedback.unshift({ at: new Date().toISOString(), day, who: p.name, text });
      LS.set("ab_feedback", feedback.slice(0, 200));
      renderFeedback();
    }
  } catch (err) {
    console.error(err);
    const s = err?.status;
    const msg = (s === 400 && /key/i.test(err.message)) || s === 401 || s === 403 ? "API-Key ungültig"
      : s === 404 ? "Modell nicht gefunden – in den Einstellungen ein anderes wählen"
      : s === 429 ? "Gratis-Kontingent erschöpft oder zu viele Anfragen – später nochmal"
      : (err?.message || "Fehler bei der KI");
    toast(msg);
  } finally {
    btn.disabled = false; btn.textContent = "Speichern + Feedback holen";
  }
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
  entries[day] = e;
  LS.set("ab_entries", entries);
  renderAll();
  toast("Gespeichert");
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
        <button data-del="${i}">Entfernen</button></div>`).join("")
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

$("entry-date").addEventListener("change", (ev) => loadDay(ev.target.value));
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
});
$("m-grid").addEventListener("click", async (ev) => {
  const id = ev.target.dataset.mdel; if (!id) return;
  await storeDelete("motivation", id);
  renderMotivation();
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

$("p-add").addEventListener("click", () => {
  const name = $("p-name").value.trim();
  if (!name) { toast("Name fehlt"); return; }
  persons.push({ name, age: $("p-age").value.trim(), rel: $("p-rel").value.trim(), style: $("p-style").value.trim() });
  LS.set("ab_persons", persons);
  ["p-name", "p-age", "p-rel", "p-style"].forEach((id) => ($(id).value = ""));
  renderPersons(); toast(name + " hinzugefügt");
});
$("persons-list").addEventListener("click", (ev) => {
  const i = ev.target.dataset.del; if (i == null) return;
  persons.splice(Number(i), 1); LS.set("ab_persons", persons); renderPersons();
});
$("persona-mode").addEventListener("change", (ev) => { settings.personaMode = ev.target.value; LS.set("ab_settings", settings); });

$("settings-save").addEventListener("click", () => {
  for (const k of ["sex", "age", "height", "activity", "tdee", "key", "model", "strict"]) settings[k] = $("s-" + k).value.trim();
  LS.set("ab_settings", settings); renderSettings(); updateDeficit(); toast("Einstellungen gespeichert");
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
    LS.set("ab_entries", entries); LS.set("ab_persons", persons); LS.set("ab_feedback", feedback); LS.set("ab_settings", settings);
    loadDay($("entry-date").value); renderAll(); toast("Backup geladen");
  } catch { toast("Backup-Datei ist ungültig"); }
});

// ---------- Start ----------
$("entry-date").value = todayIso();
loadDay(todayIso());
renderAll();
