const BACKEND = window.AUTOAPPLY_CONFIG.BACKEND_URL;

// Profile field definitions (key -> label)
const PROFILE_FIELDS = [
  ["firstName", "First name"],
  ["lastName", "Last name"],
  ["middleName", "Middle name"],
  ["fullName", "Full name"],
  ["email", "Email"],
  ["phone", "Phone"],
  ["address", "Address"],
  ["city", "City"],
  ["state", "State"],
  ["country", "Country"],
  ["zip", "Zip / PIN"],
  ["linkedin", "LinkedIn"],
  ["github", "GitHub"],
  ["portfolio", "Portfolio"],
  ["leetcode", "LeetCode"],
  ["college", "College"],
  ["degree", "Degree"],
  ["major", "Major / Branch"],
  ["cgpa", "CGPA"],
  ["gradYear", "Graduation year"],
  ["experienceYears", "Years of exp."],
  ["currentCompany", "Current company"],
  ["currentRole", "Current role"],
  ["skills", "Skills"],
  ["workAuthorized", "Work authorized"],
  ["requiresSponsorship", "Needs sponsorship"],
  ["willingToRelocate", "Will relocate"],
  ["noticePeriod", "Notice period"],
  ["expectedSalary", "Expected salary"],
  ["preferredLocation", "Preferred location"],
  ["gender", "Gender"],
  ["projects", "Projects / experience"],
];

// Options for the gender dropdown in the profile form.
const GENDER_OPTIONS = ["", "Male", "Female", "Non-binary", "Prefer not to say"];

// Fields we nag the user about if empty (the common ATS ones)
const REQUIRED_HINT = ["firstName", "lastName", "email", "phone", "city", "gradYear"];

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

let profile = {};
let applications = [];
let qaMemory = [];
let lastScan = null;

// ---- storage helpers ------------------------------------------------------
function load() {
  return new Promise((res) => {
    chrome.storage.local.get(["profile", "applications", "qaMemory"], (data) => {
      profile = data.profile || {};
      // Default country to India if it was never set.
      if (!(profile.country || "").toString().trim()) profile.country = "India";
      applications = data.applications || [];
      qaMemory = data.qaMemory || [];
      res();
    });
  });
}
function saveProfile() {
  return new Promise((res) => chrome.storage.local.set({ profile }, res));
}
function saveApps() {
  return new Promise((res) => chrome.storage.local.set({ applications }, res));
}
function saveQA() {
  return new Promise((res) => chrome.storage.local.set({ qaMemory }, res));
}

// ---- small utils ----------------------------------------------------------
function escapeHtml(s) {
  return (s || "").replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
function qaKey(s) {
  return (s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
function upsertQA(question, answer) {
  const k = qaKey(question);
  const ex = qaMemory.find((x) => qaKey(x.question) === k);
  if (ex) ex.answer = answer;
  else qaMemory.push({
    id: Date.now().toString() + Math.random().toString(36).slice(2, 6),
    question, answer,
  });
}

// Size each two-column button to the exact rendered height of its sibling
// field, so Save matches the dropdown regardless of native rendering.
function matchGridHeights() {
  document.querySelectorAll(".grid2").forEach((g) => {
    const field = g.querySelector("select.field, input.field");
    if (!field) return;
    const h = field.offsetHeight;
    if (!h) return;
    g.querySelectorAll(".btn").forEach((btn) => (btn.style.height = h + "px"));
  });
}

// ---- tabs -----------------------------------------------------------------
$$(".tab").forEach((t) =>
  t.addEventListener("click", () => {
    $$(".tab").forEach((x) => x.classList.remove("active"));
    $$(".panel").forEach((x) => x.classList.remove("active"));
    t.classList.add("active");
    $("#tab-" + t.dataset.tab).classList.add("active");
    if (t.dataset.tab === "apps") renderApps();
    if (t.dataset.tab === "stats") renderStats();
    requestAnimationFrame(matchGridHeights);
  })
);

// ---- backend health -------------------------------------------------------
async function checkBackend() {
  const dot = $("#backend-dot");
  try {
    const r = await fetch(BACKEND + "/health", { method: "GET" });
    dot.className = r.ok ? "dot ok" : "dot bad";
    dot.title = r.ok ? "Backend online" : "Backend error";
  } catch {
    dot.className = "dot bad";
    dot.title = "Backend offline — resume parsing & AI need it running";
  }
}

// ---- profile tab ----------------------------------------------------------
function renderProfile() {
  const grid = $("#profile-grid");
  grid.innerHTML = "";
  for (const [key, label] of PROFILE_FIELDS) {
    const row = document.createElement("div");
    row.className = "pf-row";
    row.innerHTML = `<label>${label}</label>`;

    if (key === "gender") {
      const sel = document.createElement("select");
      sel.className = "field";
      for (const opt of GENDER_OPTIONS) {
        const o = document.createElement("option");
        o.value = opt;
        o.textContent = opt || "— select —";
        sel.appendChild(o);
      }
      sel.value = profile[key] || "";
      sel.dataset.key = key;
      row.appendChild(sel);
      grid.appendChild(row);
      continue;
    }

    const input = document.createElement(key === "projects" ? "textarea" : "input");
    input.className = "field";
    if (key === "projects") input.rows = 3;
    input.value = profile[key] || "";
    input.dataset.key = key;
    row.appendChild(input);
    grid.appendChild(row);
  }
  renderMissing();
}

function renderMissing() {
  const missing = REQUIRED_HINT.filter((k) => !(profile[k] || "").toString().trim());
  const banner = $("#missing-banner");
  if (missing.length) {
    const labels = missing.map((k) => PROFILE_FIELDS.find((f) => f[0] === k)[1]);
    banner.textContent = "Add these for smoother autofill: " + labels.join(", ");
    banner.classList.remove("hidden");
  } else {
    banner.classList.add("hidden");
  }
}

$("#btn-save-profile").addEventListener("click", async () => {
  $$("#profile-grid [data-key]").forEach((i) => {
    profile[i.dataset.key] = i.value.trim();
  });
  await saveProfile();
  $("#profile-saved").textContent = "Saved ✓";
  setTimeout(() => ($("#profile-saved").textContent = ""), 1500);
  renderMissing();
});

// ---- resume upload --------------------------------------------------------
$("#resume-file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const status = $("#upload-status");
  status.textContent = "Parsing…";
  const fd = new FormData();
  fd.append("file", file);
  try {
    const r = await fetch(BACKEND + "/parse-resume", { method: "POST", body: fd });
    if (!r.ok) throw new Error(await r.text());
    const data = await r.json();
    // merge parsed fields into profile (don't overwrite non-empty existing)
    for (const [k, v] of Object.entries(data)) {
      if (v && (!profile[k] || !profile[k].toString().trim())) profile[k] = v;
    }
    await saveProfile();
    renderProfile();
    status.textContent = "Parsed ✓ Review below.";
  } catch (err) {
    status.textContent = "Failed — is the backend running?";
    console.error(err);
  }
});

// ---- autofill tab ---------------------------------------------------------
async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function sendToContent(tab, msg) {
  try {
    return await chrome.tabs.sendMessage(tab.id, msg);
  } catch {
    // content script not present (page loaded before install) — inject then retry
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
    return await chrome.tabs.sendMessage(tab.id, msg);
  }
}

async function scan() {
  const tab = await getActiveTab();
  if (!tab || !/^https?:/.test(tab.url || "")) {
    $("#scan-status").innerHTML = `<div class="scan-line">Open a job page (http/https) to scan.</div>`;
    return;
  }
  try {
    const res = await sendToContent(tab, { type: "SCAN", profile });
    lastScan = res;
    const chips = (res.detected || [])
      .map((d) => `<span class="chip">${d.key}</span>`)
      .join("");
    $("#scan-status").innerHTML = `
      <div class="scan-big">${res.fillable} / ${res.total}</div>
      <div class="scan-sub">fields can be autofilled on this page</div>
      <div class="chip-row">${chips}</div>`;
    $("#btn-autofill").disabled = res.fillable === 0;
    // prefill save-application form from page guess
    if (res.page) {
      if (!$("#app-url").value) $("#app-url").value = res.page.url || "";
      if (!$("#app-company").value && res.page.company) $("#app-company").value = res.page.company;
      checkDuplicate(res.page.url);
    }
  } catch (err) {
    $("#scan-status").innerHTML = `<div class="scan-line">Couldn't scan. Try reloading the page.</div>`;
    console.error(err);
  }
}

$("#btn-autofill").addEventListener("click", async () => {
  const tab = await getActiveTab();
  const result = $("#autofill-result");
  result.textContent = "Filling…";
  const res = await sendToContent(tab, { type: "AUTOFILL", profile, qa: qaMemory });
  let filled = res.filled || 0;
  let aiFilled = 0;

  // LLM fallback: try to place fields the synonym map couldn't
  const unknowns = res.unknowns || [];
  if (unknowns.length) {
    const keysWithValues = PROFILE_FIELDS.map((f) => f[0]).filter(
      (k) => (profile[k] || "").toString().trim()
    );
    try {
      const r = await fetch(BACKEND + "/match-fields", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fields: unknowns.map((u) => ({ id: u.aaId, label: u.label })),
          keys: keysWithValues,
        }),
      });
      if (r.ok) {
        const mapping = await r.json(); // { aaId: key }
        const map = [];
        for (const [aaId, key] of Object.entries(mapping)) {
          if (key && profile[key] && profile[key].toString().trim()) {
            map.push({ aaId, value: profile[key] });
          }
        }
        if (map.length) {
          const fm = await sendToContent(tab, { type: "FILL_MAP", map });
          aiFilled = fm.filled || 0;
        }
      }
    } catch (e) {
      console.warn("LLM match skipped:", e);
    }
  }

  let msg = `Filled ${filled} field${filled === 1 ? "" : "s"}`;
  if (res.qaFilled) msg += `, ${res.qaFilled} from saved answers`;
  msg += ".";
  if (aiFilled) msg += ` +${aiFilled} more via AI matching.`;
  if (res.review && res.review.length) msg += ` ${res.review.length} need a look.`;
  msg += " Review everything before submitting.";
  result.textContent = msg;
});

// ---- save application -----------------------------------------------------
function checkDuplicate(url) {
  const warn = $("#dup-warn");
  if (!url) { warn.classList.add("hidden"); return; }
  const dup = applications.find((a) => a.url && a.url === url);
  if (dup) {
    const icon = `<span class="warn-icon"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg></span>`;
    warn.innerHTML = `${icon}<span>Already saved: ${escapeHtml(dup.company || "this job")} (${escapeHtml(dup.status)}, ${dup.date}).</span>`;
    warn.classList.remove("hidden");
  } else {
    warn.classList.add("hidden");
  }
}

$("#btn-save-app").addEventListener("click", async () => {
  const app = {
    id: Date.now().toString(),
    company: $("#app-company").value.trim(),
    role: $("#app-role").value.trim(),
    url: $("#app-url").value.trim(),
    status: $("#app-status").value,
    date: new Date().toISOString().slice(0, 10),
  };
  if (!app.company && !app.role) {
    $("#autofill-result").textContent = "Add at least a company or role.";
    return;
  }
  applications.unshift(app);
  await saveApps();
  $("#app-company").value = "";
  $("#app-role").value = "";
  $("#autofill-result").textContent = "Application saved ✓";
});

// ---- AI answer ------------------------------------------------------------
$("#btn-ai").addEventListener("click", async () => {
  const q = $("#ai-question").value.trim();
  if (!q) return;
  const out = $("#ai-output");
  out.value = "Generating…";
  try {
    const r = await fetch(BACKEND + "/generate-answer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        question: q,
        company: $("#ai-company").value.trim(),
        profile,
      }),
    });
    if (!r.ok) throw new Error(await r.text());
    const data = await r.json();
    out.value = data.answer || "";
  } catch (err) {
    out.value = "Failed — is the backend running?";
    console.error(err);
  }
});

// ---- applications tab -----------------------------------------------------
const STATUSES = ["Saved", "Applied", "OA", "Interview", "Offer", "Rejected", "Withdrawn"];

function renderApps() {
  const list = $("#apps-list");
  const q = ($("#apps-search").value || "").toLowerCase();
  const filtered = applications.filter(
    (a) =>
      !q ||
      (a.company || "").toLowerCase().includes(q) ||
      (a.role || "").toLowerCase().includes(q)
  );
  $("#apps-empty").style.display = filtered.length ? "none" : "block";
  list.innerHTML = "";
  for (const a of filtered) {
    const card = document.createElement("div");
    card.className = "app-card";
    const opts = STATUSES.map(
      (s) => `<option ${s === a.status ? "selected" : ""}>${s}</option>`
    ).join("");
    card.innerHTML = `
      <div class="app-top">
        <div>
          <div class="app-company">${a.company || "—"}</div>
          <div class="app-role">${a.role || ""}</div>
        </div>
        <button class="app-del" data-id="${a.id}" title="Delete">×</button>
      </div>
      <div class="app-meta">
        <select class="app-status-sel st-${a.status}" data-id="${a.id}">${opts}</select>
        <span class="app-date">${a.date}</span>
        ${a.url ? `<a class="app-link" href="${a.url}" target="_blank">open ↗</a>` : ""}
      </div>`;
    list.appendChild(card);
  }
  // wire up status changes & deletes
  $$(".app-status-sel").forEach((sel) =>
    sel.addEventListener("change", async (e) => {
      const app = applications.find((a) => a.id === e.target.dataset.id);
      if (app) {
        app.status = e.target.value;
        await saveApps();
        renderApps();
      }
    })
  );
  $$(".app-del").forEach((btn) =>
    btn.addEventListener("click", async (e) => {
      const id = e.target.dataset.id;
      const app = applications.find((a) => a.id === id);
      const name =
        (app && [app.company, app.role].filter(Boolean).join(" — ")) ||
        "this application";
      if (!confirm(`Delete "${name}"?\n\nThis can't be undone.`)) return;
      applications = applications.filter((a) => a.id !== id);
      await saveApps();
      renderApps();
    })
  );
}
$("#apps-search").addEventListener("input", renderApps);

// ---- backup: export / import ----------------------------------------------
$("#btn-export").addEventListener("click", () => {
  const data = {
    _app: "AutoApply",
    version: 1,
    exportedAt: new Date().toISOString(),
    profile,
    applications,
    qaMemory,
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `autoapply-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  $("#backup-status").textContent = "Exported ✓ — keep the file somewhere safe.";
});

$("#import-file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const status = $("#backup-status");
  try {
    const data = JSON.parse(await file.text());
    if (!data || (!data.profile && !data.applications && !data.qaMemory)) {
      throw new Error("not a backup");
    }
    if (!confirm("Importing will replace your current profile, saved answers, and applications. Continue?")) {
      e.target.value = "";
      return;
    }
    if (data.profile) profile = data.profile;
    if (Array.isArray(data.applications)) applications = data.applications;
    if (Array.isArray(data.qaMemory)) qaMemory = data.qaMemory;
    await Promise.all([saveProfile(), saveApps(), saveQA()]);
    renderProfile();
    renderQA();
    status.textContent = "Imported ✓ — everything restored.";
  } catch (err) {
    status.textContent = "Import failed — that isn't a valid AutoApply backup file.";
    console.error(err);
  }
  e.target.value = "";
});

$("#btn-reset").addEventListener("click", async () => {
  if (!confirm(
    "Reset ALL AutoApply data?\n\n" +
    "This clears your profile, saved answers, and application history on this browser. " +
    "Export a backup first if you want to keep it.\n\nThis can't be undone."
  )) return;
  profile = {};
  applications = [];
  qaMemory = [];
  await Promise.all([saveProfile(), saveApps(), saveQA()]);
  renderProfile();
  renderQA();
  $("#backup-status").textContent = "All data cleared.";
});

// ---- saved answers (Q&A memory) -------------------------------------------
function renderQA() {
  const box = $("#qa-list");
  if (!qaMemory.length) {
    box.innerHTML = `<div class="hint">No saved answers yet. Add one below, or capture from a page.</div>`;
    return;
  }
  box.innerHTML = qaMemory.map((x) => `
    <div class="qa-item">
      <button class="qa-del" data-qa="${x.id}" title="Delete">×</button>
      <div class="qa-q">${escapeHtml(x.question)}</div>
      <div class="qa-a">${escapeHtml(x.answer)}</div>
    </div>`).join("");
  $$("#qa-list [data-qa]").forEach((b) =>
    b.addEventListener("click", async (e) => {
      qaMemory = qaMemory.filter((x) => x.id !== e.target.dataset.qa);
      await saveQA();
      renderQA();
    })
  );
}

$("#qa-add").addEventListener("click", async () => {
  const q = $("#qa-q").value.trim();
  const a = $("#qa-a").value.trim();
  if (!q || !a) return;
  upsertQA(q, a);
  await saveQA();
  renderQA();
  $("#qa-q").value = "";
  $("#qa-a").value = "";
});

$("#btn-capture").addEventListener("click", async () => {
  const tab = await getActiveTab();
  const box = $("#capture-list");
  box.innerHTML = `<div class="hint">Reading page…</div>`;
  try {
    const res = await sendToContent(tab, { type: "CAPTURE_ANSWERS" });
    const items = res.captured || [];
    if (!items.length) {
      box.innerHTML = `<div class="hint">No filled custom answers found. Type your answers on the form first, then capture.</div>`;
      return;
    }
    box.innerHTML =
      items.map((it, idx) => `
        <div class="cap-item">
          <label class="cap-row">
            <input type="checkbox" data-cap="${idx}" checked />
            <span><div class="qa-q">${escapeHtml(it.label)}</div><div class="qa-a">${escapeHtml(it.value)}</div></span>
          </label>
        </div>`).join("") +
      `<button id="btn-remember" class="btn primary">Remember selected</button>`;

    $("#btn-remember").addEventListener("click", async () => {
      const chosen = $$("#capture-list [data-cap]")
        .filter((c) => c.checked)
        .map((c) => items[+c.dataset.cap]);
      chosen.forEach((it) => upsertQA(it.label, it.value));
      await saveQA();
      renderQA();
      box.innerHTML = `<div class="hint">Saved ${chosen.length} answer(s) ✓ — see the Profile tab.</div>`;
    });
  } catch {
    box.innerHTML = `<div class="hint">Couldn't read page — reload it and retry.</div>`;
  }
});

// ---- match tab ------------------------------------------------------------
$("#btn-grab-jd").addEventListener("click", async () => {
  const tab = await getActiveTab();
  try {
    const res = await sendToContent(tab, { type: "GET_PAGE_TEXT" });
    $("#jd-input").value = res.text || "";
  } catch {
    $("#jd-input").placeholder = "Couldn't read page — reload it and retry.";
  }
});

$("#btn-analyze").addEventListener("click", async () => {
  const jd = $("#jd-input").value.trim();
  const box = $("#match-result");
  if (!jd) { box.innerHTML = `<div class="hint">Paste a job description first.</div>`; return; }
  box.innerHTML = `<div class="hint">Analyzing…</div>`;
  try {
    const r = await fetch(BACKEND + "/analyze-job", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profile, jobDescription: jd, company: $("#match-company").value.trim() }),
    });
    if (!r.ok) throw new Error(await r.text());
    const d = await r.json();
    renderMatch(d);
  } catch (e) {
    box.innerHTML = `<div class="hint">Failed — is the backend running?</div>`;
    console.error(e);
  }
});

function renderMatch(d) {
  const chips = (arr, cls) =>
    (arr || []).map((s) => `<span class="chip ${cls}">${s}</span>`).join("") ||
    `<span class="hint">none</span>`;
  const projects = (d.relevantProjects || []).map((p) => `<div>• ${p}</div>`).join("") ||
    `<span class="hint">add projects to your profile to see this</span>`;
  $("#match-result").innerHTML = `
    <div class="match-head">
      <span class="match-score">${d.matchScore}%</span>
      <span class="verdict">${d.verdict || ""}</span>
    </div>
    <div class="match-insight">${d.insight || ""}</div>
    <div class="match-sub">Matched</div><div class="chip-row">${chips(d.matched, "good")}</div>
    <div class="match-sub">Missing</div><div class="chip-row">${chips(d.missing, "miss")}</div>
    <div class="match-sub">Relevant projects</div>${projects}`;
}

$("#btn-cover").addEventListener("click", async () => {
  const out = $("#cl-output");
  out.value = "Generating…";
  try {
    const r = await fetch(BACKEND + "/generate-cover-letter", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        profile,
        jobDescription: $("#jd-input").value.trim(),
        company: $("#match-company").value.trim(),
        tone: $("#cl-tone").value,
      }),
    });
    if (!r.ok) throw new Error(await r.text());
    const d = await r.json();
    out.value = d.coverLetter || "";
  } catch (e) {
    out.value = "Failed — is the backend running?";
    console.error(e);
  }
});

// ---- analytics tab --------------------------------------------------------
function renderStats() {
  const total = applications.length;
  const by = (s) => applications.filter((a) => a.status === s).length;
  const applied = total; // every saved app counts as reaching the funnel
  const responded = applications.filter((a) =>
    ["OA", "Interview", "Offer", "Rejected"].includes(a.status)
  ).length;
  const positive = applications.filter((a) =>
    ["OA", "Interview", "Offer"].includes(a.status)
  ).length;

  const pct = (n, d) => (d ? Math.round((n / d) * 100) : 0);

  $("#stat-grid").innerHTML = `
    ${statCard(total, "Total")}
    ${statCard(by("Interview"), "Interviews")}
    ${statCard(by("Offer"), "Offers")}
    ${statCard(pct(responded, total) + "%", "Response rate")}
  `;

  const stages = [
    ["Applied", applied],
    ["OA", by("OA")],
    ["Interview", by("Interview")],
    ["Offer", by("Offer")],
    ["Rejected", by("Rejected")],
  ];
  const max = Math.max(1, ...stages.map((s) => s[1]));
  $("#funnel").innerHTML = stages
    .map(
      ([label, n]) => `
      <div class="funnel-row">
        <span class="funnel-label">${label}</span>
        <div class="funnel-bar" style="width:${(n / max) * 180}px"></div>
        <span class="funnel-val">${n}</span>
      </div>`
    )
    .join("");

  // response rate by role keyword
  const roleGroups = {};
  for (const a of applications) {
    const key = classifyRole(a.role);
    roleGroups[key] = roleGroups[key] || { total: 0, resp: 0 };
    roleGroups[key].total++;
    if (["OA", "Interview", "Offer", "Rejected"].includes(a.status)) roleGroups[key].resp++;
  }
  const rows = Object.entries(roleGroups)
    .filter(([k]) => k !== "Other" || Object.keys(roleGroups).length === 1)
    .map(
      ([k, v]) =>
        `<div class="funnel-row"><span class="funnel-label">${k}</span>
         <span class="funnel-val">${pct(v.resp, v.total)}% (${v.resp}/${v.total})</span></div>`
    )
    .join("");
  $("#role-breakdown").innerHTML = rows || "Save applications with roles to see this.";
}

function statCard(num, label) {
  return `<div class="stat-card"><div class="stat-num">${num}</div><div class="stat-label">${label}</div></div>`;
}

function classifyRole(role) {
  const r = (role || "").toLowerCase();
  if (/back.?end|api|server/.test(r)) return "Backend";
  if (/front.?end|react|ui/.test(r)) return "Frontend";
  if (/full.?stack/.test(r)) return "Full-stack";
  if (/ml|ai|data|nlp/.test(r)) return "AI/ML";
  return "Other";
}

// ---- init -----------------------------------------------------------------
(async function init() {
  await load();
  renderProfile();
  renderQA();
  checkBackend();
  scan();
  requestAnimationFrame(matchGridHeights);
})();
