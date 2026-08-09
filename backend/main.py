"""
AutoApply backend.

Only handles what genuinely needs a server:
  1. Resume -> structured profile (uses Groq; keeps your API key off the client)
  2. AI answer / cover-letter generation

Profile data and application history live in the extension (chrome.storage.local),
so this server stores nothing about the user.
"""

import io
import json
import os
import re

from dotenv import load_dotenv
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

load_dotenv()

GROQ_API_KEY = os.getenv("GROQ_API_KEY", "")
GROQ_MODEL = os.getenv("GROQ_MODEL", "llama-3.3-70b-versatile")

app = FastAPI(title="AutoApply Backend", version="0.1.0")

# Dev CORS: allow the extension (chrome-extension://...) and localhost.
# No cookies/credentials are used, so a wildcard is safe here. Restrict later.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)


# --------------------------------------------------------------------------
# Groq helper
# --------------------------------------------------------------------------
def groq_chat(system: str, user: str, max_tokens: int = 1024, json_mode: bool = False) -> str:
    if not GROQ_API_KEY:
        raise HTTPException(500, "GROQ_API_KEY not set on the server (.env).")
    # Imported lazily so the app still boots without the package during setup.
    from groq import Groq

    client = Groq(api_key=GROQ_API_KEY)
    base = dict(
        model=GROQ_MODEL,
        messages=[
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        temperature=0.3,
        max_tokens=max_tokens,
    )

    # For JSON endpoints on reasoning models (gpt-oss), we want: valid JSON out,
    # minimal thinking, and the reasoning kept OUT of message.content (otherwise
    # it truncates or pollutes the JSON). Try the richest config first and
    # degrade gracefully if the model/SDK rejects a parameter.
    attempts = []
    if json_mode:
        j = {"type": "json_object"}
        attempts.append({**base, "response_format": j, "reasoning_effort": "low", "reasoning_format": "hidden"})
        attempts.append({**base, "response_format": j, "reasoning_effort": "low"})
        attempts.append({**base, "response_format": j})
    attempts.append(base)

    last_err = None
    for kw in attempts:
        try:
            resp = client.chat.completions.create(**kw)
            content = resp.choices[0].message.content or ""
            if content.strip():
                return content
        except Exception as e:
            last_err = e
    if last_err:
        raise HTTPException(502, f"Groq call failed: {last_err}")
    return ""


def to_int(v, default: int = 0) -> int:
    """Coerce '82', '82%', '82/100', 82.0 -> 82 without throwing."""
    if isinstance(v, (int, float)):
        return int(v)
    m = re.search(r"\d+", str(v))
    return int(m.group()) if m else default


def strip_json(text: str) -> str:
    """Groq sometimes wraps JSON in ```json fences. Strip them."""
    t = text.strip()
    if t.startswith("```"):
        t = t.split("```", 2)[1] if "```" in t[3:] else t[3:]
        t = t.replace("json", "", 1).strip() if t.lstrip().startswith("json") else t
    # last-ditch: grab first { ... last }
    if "{" in t and "}" in t:
        t = t[t.index("{") : t.rindex("}") + 1]
    return t.strip()


# --------------------------------------------------------------------------
# Resume text extraction
# --------------------------------------------------------------------------
def extract_text(filename: str, data: bytes) -> str:
    name = filename.lower()
    if name.endswith(".pdf"):
        import fitz  # PyMuPDF

        doc = fitz.open(stream=data, filetype="pdf")
        return "\n".join(page.get_text() for page in doc)
    if name.endswith(".docx"):
        import docx

        d = docx.Document(io.BytesIO(data))
        return "\n".join(p.text for p in d.paragraphs)
    if name.endswith(".txt"):
        return data.decode("utf-8", errors="ignore")
    raise HTTPException(400, "Unsupported file type. Use PDF, DOCX, or TXT.")


PROFILE_KEYS = [
    "firstName", "lastName", "fullName", "email", "phone", "address", "city",
    "state", "country", "zip", "linkedin", "github", "portfolio", "leetcode",
    "college", "degree", "major", "cgpa", "gradYear", "experienceYears",
    "currentCompany", "currentRole", "skills",
    "workAuthorized", "requiresSponsorship", "willingToRelocate",
    "noticePeriod", "expectedSalary", "preferredLocation", "projects",
]

PARSE_SYSTEM = (
    "You extract structured candidate data from resume text. "
    "Return ONLY a JSON object, no markdown, no commentary. "
    f"Use exactly these keys: {', '.join(PROFILE_KEYS)}. "
    "Leave a value as an empty string if the resume does not contain it. "
    "For 'skills', return a comma-separated string. "
    "For 'projects', return up to 4 items as 'Name — one-line description', newline-separated. "
    "For 'gradYear', return just the year. Do not invent information."
)


# --------------------------------------------------------------------------
# Request models
# --------------------------------------------------------------------------
class AnswerRequest(BaseModel):
    question: str
    company: str = ""
    jobDescription: str = ""
    profile: dict = {}


class CoverLetterRequest(BaseModel):
    company: str = ""
    jobDescription: str = ""
    profile: dict = {}
    tone: str = "normal"  # short | normal | formal


class MatchRequest(BaseModel):
    fields: list = []  # [{"id": "...", "label": "..."}]
    keys: list = []    # available profile keys that have values


class AnalyzeRequest(BaseModel):
    profile: dict = {}
    jobDescription: str = ""
    company: str = ""


# --------------------------------------------------------------------------
# Routes
# --------------------------------------------------------------------------
@app.get("/health")
def health():
    return {"ok": True, "model": GROQ_MODEL, "key_set": bool(GROQ_API_KEY)}


@app.post("/parse-resume")
async def parse_resume(file: UploadFile = File(...)):
    data = await file.read()
    if not data:
        raise HTTPException(400, "Empty file.")
    text = extract_text(file.filename or "resume", data)
    if len(text.strip()) < 30:
        raise HTTPException(422, "Could not read text from this file (scanned image?).")

    raw = groq_chat(PARSE_SYSTEM, text[:12000], max_tokens=1500, json_mode=True)
    try:
        parsed = json.loads(strip_json(raw))
    except Exception:
        print("[parse-resume] unparseable output:", repr(raw[:400]))
        raise HTTPException(502, "Model did not return valid JSON. Try again.")

    # keep only known keys, coerce to strings
    clean = {k: (str(parsed.get(k, "")).strip() if parsed.get(k) is not None else "")
             for k in PROFILE_KEYS}
    return clean


@app.post("/generate-answer")
def generate_answer(req: AnswerRequest):
    p = req.profile or {}
    context = (
        f"Candidate: {p.get('fullName') or (p.get('firstName','') + ' ' + p.get('lastName','')).strip()}\n"
        f"Skills: {p.get('skills','')}\n"
        f"Education: {p.get('degree','')} in {p.get('major','')}, {p.get('college','')} "
        f"(grad {p.get('gradYear','')})\n"
        f"Current: {p.get('currentRole','')} at {p.get('currentCompany','')}\n"
        f"Links: {p.get('github','')} {p.get('portfolio','')}\n"
    )
    system = (
        "You help a job candidate answer an application question. "
        "Write in first person, specific and honest, grounded in the candidate context. "
        "No clichés, no filler, no invented facts. 90-150 words unless the question implies shorter."
    )
    user = (
        f"{context}\n"
        f"Company: {req.company or 'the company'}\n"
        f"Job description (may be blank):\n{req.jobDescription[:3000]}\n\n"
        f"Application question: {req.question}\n\n"
        "Write only the answer."
    )
    return {"answer": groq_chat(system, user, max_tokens=512).strip()}


@app.post("/generate-cover-letter")
def generate_cover_letter(req: CoverLetterRequest):
    p = req.profile or {}
    length = {"short": "120-150 words", "formal": "250-320 words"}.get(req.tone, "180-220 words")
    system = (
        "You write concise, specific cover letters for a job candidate. "
        "Ground every claim in the provided context. No generic openings, no invented facts."
    )
    user = (
        f"Candidate skills: {p.get('skills','')}\n"
        f"Education: {p.get('degree','')} {p.get('major','')}, {p.get('college','')}\n"
        f"Company: {req.company}\n"
        f"Job description:\n{req.jobDescription[:3000]}\n\n"
        f"Write a {length} cover letter."
    )
    return {"coverLetter": groq_chat(system, user, max_tokens=700).strip()}


@app.post("/match-fields")
def match_fields(req: MatchRequest):
    """Map form-field labels the extension couldn't place to profile keys."""
    if not req.fields or not req.keys:
        return {}
    valid = set(req.keys)
    system = (
        "You map job-application form fields to a candidate's profile keys. "
        "For each field id, choose the single best key from the allowed list, or "
        "null if none fit. Never guess demographic fields. "
        "Return ONLY a JSON object of id -> key-or-null, no markdown."
    )
    listing = "\n".join(f'{f.get("id")}: {f.get("label","")}' for f in req.fields)
    user = f"Allowed keys: {sorted(valid)}\n\nFields:\n{listing}"
    raw = groq_chat(system, user, max_tokens=512, json_mode=True)
    try:
        mapping = json.loads(strip_json(raw))
    except Exception:
        return {}
    # keep only valid key values
    return {k: v for k, v in mapping.items() if v in valid}


@app.post("/analyze-job")
def analyze_job(req: AnalyzeRequest):
    """Compare the candidate to a job description: score, matched/missing skills,
    relevant projects, and a short verdict + insight."""
    p = req.profile or {}
    if not req.jobDescription.strip():
        raise HTTPException(400, "No job description provided.")

    context = (
        f"Candidate skills: {p.get('skills','')}\n"
        f"Projects/experience:\n{p.get('projects','')}\n"
        f"Education: {p.get('degree','')} {p.get('major','')}, {p.get('college','')} "
        f"(grad {p.get('gradYear','')})\n"
        f"Years of experience: {p.get('experienceYears','')}\n"
    )
    system = (
        "You assess how well a candidate fits a job. Return ONLY a JSON object, no markdown, "
        "with keys: matchScore (integer 0-100), matched (array of skills the candidate genuinely "
        "has that the job wants), missing (array of skills the job wants that the candidate lacks), "
        "relevantProjects (array of short strings naming the candidate's projects most relevant to "
        "this job), verdict (one of: 'Strong fit','Good fit','Partial fit','Weak fit'), "
        "insight (one honest sentence of advice). Only list matched skills the candidate actually "
        "has. Do not invent skills or projects."
    )
    user = f"{context}\nCompany: {req.company or 'the company'}\nJob description:\n{req.jobDescription[:4000]}"
    raw = groq_chat(system, user, max_tokens=1500, json_mode=True)
    try:
        data = json.loads(strip_json(raw))
    except Exception:
        print("[analyze-job] unparseable output:", repr(raw[:400]))
        raise HTTPException(502, "Model did not return valid JSON. Try again.")

    def as_list(v):
        if isinstance(v, list):
            return [str(x) for x in v]
        if isinstance(v, str) and v.strip():
            return [s.strip() for s in re.split(r"[,\n]", v) if s.strip()]
        return []

    return {
        "matchScore": max(0, min(100, to_int(data.get("matchScore", 0)))),
        "matched": as_list(data.get("matched")),
        "missing": as_list(data.get("missing")),
        "relevantProjects": as_list(data.get("relevantProjects")),
        "verdict": str(data.get("verdict", "") or ""),
        "insight": str(data.get("insight", "") or ""),
    }
