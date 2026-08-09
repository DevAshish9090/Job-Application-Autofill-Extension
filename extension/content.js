// AutoApply content script — v1.5
// Detects fields (incl. shadow DOM + same-origin iframes), matches them to the
// candidate profile, and fills text inputs, native selects, custom dropdowns
// (react-select style), and radio/checkbox questions. Fields the synonym map
// can't place are returned so the popup can ask the LLM to map them.

(() => {
  if (window.__AUTOAPPLY_LOADED__) return;
  window.__AUTOAPPLY_LOADED__ = true;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---- Synonym map (ordered; distinctive keys first) ---------------------
  const FIELD_ORDER = [
    "email", "phone", "linkedin", "github", "leetcode", "portfolio",
    "zip", "cgpa", "gradYear", "experienceYears",
    "workAuthorized", "requiresSponsorship", "willingToRelocate",
    "noticePeriod", "expectedSalary", "preferredLocation",
    "firstName", "middleName", "lastName", "currentCompany", "currentRole",
    "college", "degree", "major", "skills",
    "city", "state", "country", "address", "fullName",
  ];

  const FIELD_SYNONYMS = {
    firstName: ["first name", "given name", "fname", "forename", "candidate first", "legal first"],
    middleName: ["middle name", "legal middle", "middle initial"],
    lastName: ["last name", "surname", "family name", "lname"],
    fullName: ["full name", "legal name", "candidate name", "your name", "name"],
    email: ["email", "e-mail", "email address"],
    phone: ["phone", "mobile", "telephone", "contact number", "phone number", "cell"],
    address: ["address", "street address", "address line", "current address", "residential"],
    city: ["city", "town"],
    state: ["state", "province", "region"],
    country: ["country", "nationality"],
    zip: ["zip", "postal code", "postcode", "pin code", "zipcode"],
    linkedin: ["linkedin", "linked in"],
    github: ["github", "git hub"],
    portfolio: ["portfolio", "personal website", "website", "personal site", "url"],
    leetcode: ["leetcode", "leet code"],
    college: ["college", "university", "school", "institution"],
    degree: ["degree", "qualification"],
    major: ["major", "field of study", "branch", "specialization", "discipline", "stream"],
    cgpa: ["cgpa", "gpa", "grade point", "percentage", "aggregate"],
    gradYear: ["graduation year", "grad year", "year of graduation", "passing year",
               "graduation date", "expected graduation", "year of passing"],
    experienceYears: ["years of experience", "total experience", "work experience", "yrs of exp"],
    currentCompany: ["current company", "employer", "company name", "organization", "current employer"],
    currentRole: ["current role", "current title", "job title", "designation", "current position"],
    skills: ["skills", "technical skills", "key skills", "core skills"],
    workAuthorized: ["authorized to work", "work authorization", "legally authorized",
                     "right to work", "eligible to work", "work permit"],
    requiresSponsorship: ["require sponsorship", "need sponsorship", "visa sponsorship",
                          "sponsorship", "require a visa"],
    willingToRelocate: ["willing to relocate", "open to relocation", "relocate"],
    noticePeriod: ["notice period"],
    expectedSalary: ["expected salary", "salary expectation", "desired salary",
                     "expected ctc", "compensation expectation"],
    preferredLocation: ["preferred location", "preferred work location", "location preference"],
  };

  // ---- Root gathering (shadow DOM + same-origin iframes) -----------------
  function gatherRoots() {
    const roots = [document];
    const seen = new Set();
    const visit = (root) => {
      if (seen.has(root)) return;
      seen.add(root);
      let all;
      try { all = root.querySelectorAll("*"); } catch { return; }
      for (const el of all) {
        if (el.shadowRoot) visit(el.shadowRoot);
        if (el.tagName === "IFRAME") {
          try { if (el.contentDocument) visit(el.contentDocument); } catch { /* cross-origin */ }
        }
      }
    };
    visit(document);
    return roots;
  }

  function queryAll(roots, selector) {
    const out = [];
    for (const root of roots) {
      try { root.querySelectorAll(selector).forEach((e) => out.push(e)); } catch {}
    }
    return out;
  }

  // ---- Label extraction --------------------------------------------------
  const textOf = (n) => (n ? n.textContent || "" : "").replace(/\s+/g, " ").trim();

  function getFieldLabel(el) {
    const parts = [];
    const root = el.getRootNode();
    if (el.id) {
      let lab;
      try { lab = root.querySelector(`label[for="${CSS.escape(el.id)}"]`); } catch {}
      if (lab) parts.push(textOf(lab));
    }
    const wrap = el.closest && el.closest("label");
    if (wrap) parts.push(textOf(wrap));
    const lb = el.getAttribute && el.getAttribute("aria-labelledby");
    if (lb) lb.split(/\s+/).forEach((id) => {
      const n = root.getElementById ? root.getElementById(id) : document.getElementById(id);
      if (n) parts.push(textOf(n));
    });
    ["aria-label", "placeholder", "name", "id", "title"].forEach((a) => {
      const v = el.getAttribute && el.getAttribute(a);
      // Normalize "firstName"/"first_name" -> "first name" so camelCase field
      // names match the synonym list instead of falling through to "name".
      if (v) parts.push(v.replace(/[_\-]+/g, " ").replace(/([a-z0-9])([A-Z])/g, "$1 $2"));
    });
    const prev = el.previousElementSibling;
    if (prev && textOf(prev).length < 60) parts.push(textOf(prev));
    return parts.join(" ").toLowerCase();
  }

  function matchKey(label) {
    if (!label) return null;
    for (const key of FIELD_ORDER) {
      for (const s of FIELD_SYNONYMS[key]) if (label.includes(s)) return key;
    }
    return null;
  }

  // If firstName holds the whole name (common after resume parsing) and
  // lastName is empty or a duplicate, split it so First/Last fields fill right.
  function resolveName(p) {
    let first = (p.firstName || "").trim();
    let last = (p.lastName || "").trim();
    const full = (p.fullName || "").trim();
    if (first.includes(" ") && (!last || last === first || full === first)) {
      const parts = first.split(/\s+/);
      first = parts[0];
      last = parts.slice(1).join(" ");
    } else if (!first && full.includes(" ")) {
      const parts = full.split(/\s+/);
      first = parts[0];
      last = parts.slice(1).join(" ");
    }
    if (!last && full.includes(" ")) last = full.split(/\s+/).slice(1).join(" ");
    return { first, last };
  }

  // ---- Saved-answer (Q&A) local matching ---------------------------------
  const QA_STOP = new Set(["what", "is", "are", "your", "the", "a", "an", "do", "does",
    "you", "have", "to", "of", "for", "please", "provide", "enter", "we", "our",
    "this", "that", "in", "on", "at", "be", "will", "would", "can", "any", "if"]);
  function qaTokens(s) {
    return (s || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/)
      .filter((w) => w.length > 1 && !QA_STOP.has(w));
  }
  function qaOverlap(a, b) {
    const A = new Set(a), B = new Set(b);
    if (!A.size || !B.size) return 0;
    let i = 0; A.forEach((t) => { if (B.has(t)) i++; });
    return i / Math.min(A.size, B.size); // overlap coefficient
  }
  function bestQaAnswer(label, qa) {
    const lt = qaTokens(label);
    if (!lt.length) return null;
    let best = null, bestScore = 0;
    for (const item of qa) {
      const s = qaOverlap(lt, qaTokens(item.question || ""));
      if (s > bestScore) { bestScore = s; best = item; }
    }
    return bestScore >= 0.6 && best ? (best.answer || "") : null;
  }

  // ---- Controlled-input safe value set -----------------------------------
  function setNativeValue(el, value) {
    const proto =
      el.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype
      : el.tagName === "SELECT" ? window.HTMLSelectElement.prototype
      : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(el, value); else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function flash(el) {
    try {
      el.style.outline = "2px solid #22c55e";
      setTimeout(() => (el.style.outline = ""), 1500);
    } catch {}
  }

  // ---- Phone formatting --------------------------------------------------
  // If a phone field can only hold ~10 digits (a separate "+91" is shown, or
  // maxlength/pattern constrains it), fill the national number without the
  // country code. Otherwise keep the full value (e.g. "+91 98765 43210").
  function looksLikePhone(el) {
    const type = (el.type || "").toLowerCase();
    if (type === "tel") return true;
    const hay = [
      el.name, el.id,
      el.getAttribute && el.getAttribute("placeholder"),
      el.getAttribute && el.getAttribute("aria-label"),
    ].join(" ").toLowerCase();
    return /phone|mobile|\btel\b|contact number|whatsapp/.test(hay);
  }

  function phoneForField(el, raw) {
    const str = String(raw).trim();
    const digits = str.replace(/\D/g, "");
    const national = digits.length > 10 ? digits.slice(-10) : digits;
    const maxLen = el.maxLength && el.maxLength > 0 ? el.maxLength : null;
    const pattern = (el.getAttribute && el.getAttribute("pattern")) || "";
    const placeholder = (el.getAttribute && el.getAttribute("placeholder")) || "";

    const wantsTen =
      (maxLen && maxLen <= 10) ||
      /\{?\s*10\s*\}?/.test(pattern) ||       // pattern like [0-9]{10}
      /\b10[\s-]?digit/.test(placeholder.toLowerCase());
    if (wantsTen) return national;

    // Full formatted value won't fit — prefer national digits.
    if (maxLen && str.length > maxLen) {
      return national.length <= maxLen ? national : digits.slice(-maxLen);
    }
    return str; // keep country code
  }

  // ---- Native <select> ---------------------------------------------------
  function fillSelect(el, value) {
    const t = String(value).toLowerCase().trim();
    const opts = Array.from(el.options);
    const m =
      opts.find((o) => o.value.toLowerCase() === t) ||
      opts.find((o) => o.textContent.toLowerCase().trim() === t) ||
      opts.find((o) => o.textContent.toLowerCase().includes(t)) ||
      opts.find((o) => t.includes(o.textContent.toLowerCase().trim()) && o.textContent.trim());
    if (m) {
      el.value = m.value;
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }
    return false;
  }

  // ---- Custom dropdown (react-select / listbox combobox) -----------------
  function isCombobox(el) {
    const role = el.getAttribute && el.getAttribute("role");
    if (role === "combobox") return true;
    if (el.getAttribute && el.getAttribute("aria-haspopup") === "listbox") return true;
    const cls = (el.className || "").toString();
    return /select__control|css-.*-control|Select-control/.test(cls);
  }

  async function fillCombobox(container, value, roots) {
    const input = (container.querySelector && container.querySelector("input")) || container;
    try { input.focus(); } catch {}
    container.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    container.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    await sleep(140);
    if (input && input.tagName === "INPUT") {
      setNativeValue(input, value);
      input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: value.slice(-1) || "a" }));
      input.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: value.slice(-1) || "a" }));
    }
    await sleep(300);
    const liveRoots = gatherRoots(); // listbox may have been portaled/added
    const opts = queryAll(liveRoots, '[role="option"], .select__option, li[role="option"], .Select-option');
    const t = String(value).toLowerCase().trim();
    const m =
      opts.find((o) => textOf(o).toLowerCase() === t) ||
      opts.find((o) => textOf(o).toLowerCase().includes(t));
    if (m) {
      m.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      m.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      m.click();
      return true;
    }
    if (input && input.tagName === "INPUT") {
      input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter", keyCode: 13 }));
    }
    return false;
  }

  // ---- Radio / checkbox groups -------------------------------------------
  function radioLabel(r) {
    const root = r.getRootNode();
    if (r.id) {
      let l; try { l = root.querySelector(`label[for="${CSS.escape(r.id)}"]`); } catch {}
      if (l) return textOf(l);
    }
    const wrap = r.closest && r.closest("label");
    if (wrap) return textOf(wrap);
    const next = r.nextElementSibling;
    if (next && textOf(next).length < 40) return textOf(next);
    return (r.getAttribute("aria-label") || r.value || "").toString();
  }

  function groupQuestionLabel(r) {
    const fs = r.closest && r.closest("fieldset");
    if (fs) {
      const legend = fs.querySelector("legend");
      if (legend) return textOf(legend).toLowerCase();
    }
    // climb a couple of levels for a heading/label-ish text
    let node = r.parentElement;
    for (let i = 0; i < 3 && node; i++) {
      const own = Array.from(node.childNodes)
        .filter((n) => n.nodeType === 3)
        .map((n) => n.textContent)
        .join(" ")
        .trim();
      if (own && own.length > 3) return own.toLowerCase();
      const lbl = node.querySelector && node.querySelector("label, legend, .label, [class*='question' i]");
      if (lbl) return textOf(lbl).toLowerCase();
      node = node.parentElement;
    }
    return "";
  }

  function collectRadioGroups(roots) {
    const radios = queryAll(roots, 'input[type="radio"]');
    const groups = new Map();
    radios.forEach((r) => {
      const key = (r.name || "") + "::" + (r.getRootNode().host ? "shadow" : "doc");
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    });
    return [...groups.values()].filter((g) => g.length);
  }

  function fillRadioGroup(group, value) {
    const t = String(value).toLowerCase().trim();
    for (const r of group) {
      const lab = radioLabel(r).toLowerCase();
      if (lab === t || lab.startsWith(t) || (lab && (lab.includes(t) || t.includes(lab)))) {
        r.checked = true;
        r.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        r.dispatchEvent(new Event("change", { bubbles: true }));
        flash(r);
        return true;
      }
    }
    return false;
  }

  // ---- Value-field collection --------------------------------------------
  let AA_COUNTER = 0;
  function collectValueFields(roots) {
    const els = queryAll(roots, "input, textarea, select, [role='combobox']").filter((el) => {
      if (el.disabled || el.readOnly) return false;
      const type = (el.type || "").toLowerCase();
      if (["hidden", "submit", "button", "reset", "file", "image", "password", "radio", "checkbox"].includes(type)) return false;
      const rect = el.getBoundingClientRect ? el.getBoundingClientRect() : { width: 1, height: 1 };
      if (rect.width === 0 && rect.height === 0) return false;
      return true;
    });
    return els.map((el) => {
      if (!el.dataset.aaId) el.dataset.aaId = "aa" + AA_COUNTER++;
      return { el, aaId: el.dataset.aaId, key: matchKey(getFieldLabel(el)), label: getFieldLabel(el).slice(0, 80) };
    });
  }

  function findByAaId(roots, aaId) {
    for (const root of roots) {
      try {
        const el = root.querySelector(`[data-aa-id="${aaId}"]`);
        if (el) return el;
      } catch {}
    }
    return null;
  }

  async function fillOne(el, value, roots) {
    if (!el) return false;
    if (el.tagName === "SELECT") return fillSelect(el, value);
    if (isCombobox(el)) return await fillCombobox(el, value, roots);
    let v = String(value);
    if (looksLikePhone(el) && v.replace(/\D/g, "").length >= 7) v = phoneForField(el, v);
    setNativeValue(el, v);
    flash(el);
    return true;
  }

  // ---- Page info ---------------------------------------------------------
  function guessPageInfo() {
    const meta = (n) => document.querySelector(`meta[property="${n}"], meta[name="${n}"]`)?.content || "";
    const company =
      meta("og:site_name") ||
      document.querySelector('[class*="company" i]')?.textContent?.trim()?.slice(0, 60) || "";
    return { url: location.href, title: (document.title || "").slice(0, 100),
             company: company.replace(/\s+/g, " ").trim() };
  }

  // ---- Message handling --------------------------------------------------
  chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
    const profile = msg.profile || {};

    if (msg.type === "SCAN") {
      const roots = gatherRoots();
      const fields = collectValueFields(roots);
      const radioGroups = collectRadioGroups(roots);
      const has = (k) => profile[k] != null && String(profile[k]).trim() !== "";

      const fillableValue = fields.filter((f) => f.key && has(f.key));
      const fillableRadio = radioGroups.filter((g) => {
        const k = matchKey(groupQuestionLabel(g[0]));
        return k && has(k);
      });
      const unknown = fields.filter((f) => !f.key).length;

      sendResponse({
        total: fields.length + radioGroups.length,
        fillable: fillableValue.length + fillableRadio.length,
        detected: [...fillableValue.map((f) => ({ key: f.key, label: f.label })),
                   ...fillableRadio.map((g) => ({ key: matchKey(groupQuestionLabel(g[0])), label: "radio" }))],
        unknownCount: unknown,
        page: guessPageInfo(),
      });
      return true;
    }

    if (msg.type === "AUTOFILL") {
      (async () => {
        const roots = gatherRoots();
        const fields = collectValueFields(roots);
        const radioGroups = collectRadioGroups(roots);
        const has = (k) => profile[k] != null && String(profile[k]).trim() !== "";
        const names = resolveName(profile);
        let filled = 0;
        const done = new Set();
        const review = [];

        // value fields
        for (const f of fields) {
          if (!f.key || done.has(f.el)) continue;
          let val = profile[f.key];
          if (f.key === "firstName") val = names.first || val;
          else if (f.key === "lastName") val = names.last || val;
          if (val == null || String(val).trim() === "") continue;
          try {
            const ok = await fillOne(f.el, val, roots);
            if (ok) { filled++; done.add(f.el); }
            else review.push({ label: f.label, reason: "no matching option" });
          } catch { review.push({ label: f.label, reason: "could not fill" }); }
        }

        // radio groups
        for (const g of radioGroups) {
          const k = matchKey(groupQuestionLabel(g[0]));
          if (k && has(k)) { if (fillRadioGroup(g, profile[k])) filled++; }
        }

        // saved-answer (Q&A) memory — fills any field left unfilled above,
        // whether or not it matched a profile key (so an empty profile field
        // can still be filled from a saved answer).
        const qa = msg.qa || [];
        let qaFilled = 0;
        if (qa.length) {
          for (const f of fields) {
            if (done.has(f.el)) continue;
            const ans = bestQaAnswer(f.label, qa);
            if (ans != null && ans !== "") {
              try { setNativeValue(f.el, String(ans)); flash(f.el); filled++; qaFilled++; done.add(f.el); } catch {}
            }
          }
        }

        // fields we couldn't place — hand back for LLM matching
        const unknowns = fields
          .filter((f) => !f.key && !done.has(f.el))
          .map((f) => ({ aaId: f.aaId, label: f.label }));

        sendResponse({ filled, qaFilled, review, unknowns, page: guessPageInfo() });
      })();
      return true;
    }

    if (msg.type === "FILL_MAP") {
      (async () => {
        const roots = gatherRoots();
        let filled = 0;
        for (const item of msg.map || []) {
          const el = findByAaId(roots, item.aaId);
          try { if (await fillOne(el, item.value, roots)) filled++; } catch {}
        }
        sendResponse({ filled });
      })();
      return true;
    }

    if (msg.type === "GET_PAGE_TEXT") {
      const t = (document.body ? document.body.innerText : "")
        .replace(/\n{3,}/g, "\n\n")
        .trim()
        .slice(0, 8000);
      sendResponse({ text: t });
      return true;
    }

    if (msg.type === "CAPTURE_ANSWERS") {
      const roots = gatherRoots();
      const fields = collectValueFields(roots);
      const captured = [];
      for (const f of fields) {
        const val = (f.el.value || "").toString().trim();
        if (!val || f.key) continue;      // skip empty + profile-mapped fields
        if (val.length > 500) continue;   // skip huge blobs
        captured.push({ label: f.label, value: val });
      }
      sendResponse({ captured });
      return true;
    }
  });
})();
