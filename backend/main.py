"""FFU Analyzer backend.

The original app gave the model a list of filenames and let it pull whole
documents into context.  This version searches the package page by page and
answers with citations, and it knows which documents and which passages are
still in force.
"""

import json
import logging
import os
import re
import shutil
import tempfile
import threading
from pathlib import Path

from fastapi import FastAPI, HTTPException, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from dotenv import load_dotenv
from openai import OpenAI

import ingest

logging.basicConfig(level=logging.INFO, format="%(message)s")
logger = logging.getLogger(__name__)

BASE = Path(__file__).resolve().parent
load_dotenv(BASE.parent / ".env")

DATA_DIR = Path(os.environ.get("FFU_DATA_DIR", BASE / "data"))
DB_PATH = Path(os.environ.get("FFU_DB_PATH", BASE / "ffu.db"))
MODEL = os.environ.get("OPENAI_MODEL", "gpt-5.4")
FRONTEND_DIST = BASE.parent / "frontend" / "dist"

DATA_DIR.mkdir(parents=True, exist_ok=True)
db = ingest.connect(DB_PATH)
_client: OpenAI | None = None
_ingest_lock = threading.Lock()
_status = {"running": False, "message": ""}


def client() -> OpenAI:
    global _client
    if _client is None:
        _client = OpenAI(api_key=os.environ["OPENAI_API_KEY"])
    return _client


app = FastAPI()
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

# --------------------------------------------------------------------------
# search
# --------------------------------------------------------------------------

STOPWORDS = {"och", "att", "för", "som", "med", "den", "det", "vad", "är", "the", "and", "what", "which"}


def fts_query(text: str) -> str:
    """Build an FTS5 query.

    Swedish compounds ("kabelskyddsrör") and AMA codes ("SBC.21") both matter,
    so terms are matched as prefixes and codes are kept as phrases.
    """
    terms = []
    for token in re.findall(r"[\wÅÄÖåäö]+(?:[.\-][\wÅÄÖåäö]+)*", text):
        if token.lower() in STOPWORDS or len(token) < 2:
            continue
        token = token.replace('"', "")
        terms.append(f'"{token}"*' if len(token) >= 4 and "." not in token else f'"{token}"')
    return " OR ".join(terms[:24])


def search(query: str, limit: int = 8, include_superseded: bool = False) -> list[dict]:
    expression = fts_query(query)
    if not expression:
        return []
    rows = db.execute(
        """SELECT c.doc_id, c.page, c.section, c.text,
                  d.display_name, d.number, d.category, d.rev_date, d.superseded_by,
                  bm25(chunks, 3.0, 2.0, 1.0) AS score
           FROM chunks c JOIN documents d ON d.id = c.doc_id
           WHERE chunks MATCH ? AND (? OR d.superseded_by IS NULL)
           ORDER BY score LIMIT ?""",
        (expression, 1 if include_superseded else 0, limit),
    ).fetchall()
    return [dict(row) for row in rows]


def page_status(doc_id: int, page: int) -> list[str]:
    """Change marks on a page, so a hit can be labelled in the answer."""
    rows = db.execute(
        "SELECT kind, COUNT(*) n FROM marks WHERE doc_id=? AND page=? GROUP BY kind", (doc_id, page)
    ).fetchall()
    labels = []
    for row in rows:
        if row["kind"] == "struck":
            labels.append(f"{row['n']} struken rad (utgår)")
        else:
            labels.append(f"{row['n']} ändringsmarkering")
    return labels


def document_lines() -> str:
    """The package as the model sees it, newest versions first."""
    lines = []
    for row in db.execute(
        "SELECT id, display_name, number, category, rev_date, superseded_by FROM documents ORDER BY precedence, number"
    ):
        flags = []
        if row["rev_date"]:
            flags.append(f"reviderad {row['rev_date']}")
        if row["superseded_by"]:
            flags.append("ERSATT av nyare version")
        marks = db.execute("SELECT COUNT(*) FROM marks WHERE doc_id=?", (row["id"],)).fetchone()[0]
        if marks:
            flags.append(f"{marks} ändringsmarkeringar")
        lines.append(
            f"- id {row['id']}: {row['display_name']} [{row['category']}]"
            + (f" ({', '.join(flags)})" if flags else "")
        )
    return "\n".join(lines)


def kfu_summary() -> str:
    rows = db.execute(
        """SELECT k.target, k.description, d.display_name AS kfu, t.display_name AS target_doc
           FROM kfu_changes k JOIN documents d ON d.id = k.kfu_id
           LEFT JOIN documents t ON t.id = k.target_doc_id
           WHERE k.kind = 'handling'"""
    ).fetchall()
    return "\n".join(
        f"- {row['kfu']} ändrar {row['target']}"
        + (f" → {row['target_doc']}" if row["target_doc"] else " (handlingen saknas i paketet)")
        for row in rows
    ) or "Inga ändrings-PM hittades."


SYSTEM = """Du är en FFU-analytiker för svenska förfrågningsunderlag (bygg/anläggning).
Användaren är oftast kalkylator eller entreprenör som ska lämna anbud.

Arbetssätt:
- Använd ALLTID verktyget search_ffu innan du svarar på en sakfråga. Sök flera gånger
  med olika termer (synonymer, AMA-koder, sammansatta ord) om första sökningen inte räcker.
- Svara på användarens språk. Var kort och konkret.
- Ange källa för varje påstående med [S1], [S2] osv. Sökträffarna har sådana id.
- Hittar du inte uppgiften: säg det. Gissa aldrig siffror, mängder eller datum.

Handlingarnas giltighet (AFB.32 listar handlingarna, AFB.33 gör kompletterande
handlingar gällande):
- Ändrings-PM (KFU) och kompletteringar gäller före tidigare handlingar.
- Reviderade versioner gäller före originalet. Ersatta versioner används inte
  som svar, bara för att förklara vad som ändrats.
- Text markerad [STRUKEN — utgår enligt revidering] gäller INTE längre. Nämn
  det uttryckligen när frågan rör sådan text.
- Text markerad [ÄNDRAD i revidering] är ändrad i den senaste revideringen.

Handlingar i paketet:
{documents}

Ändrings-PM:
{kfu}
"""

TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "search_ffu",
            "description": "Sök i förfrågningsunderlaget. Returnerar sidvisa träffar med källid.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Sökord, gärna svenska facktermer eller AMA-koder."},
                    "include_superseded": {
                        "type": "boolean",
                        "description": "Ta även med ersatta versioner, för att jämföra vad som ändrats.",
                    },
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "read_page",
            "description": "Läs en hel sida i en handling när träffen är avklippt.",
            "parameters": {
                "type": "object",
                "properties": {"doc_id": {"type": "integer"}, "page": {"type": "integer"}},
                "required": ["doc_id", "page"],
            },
        },
    },
]


def register(sources: dict, doc_id: int, page: int, section: str, document: str,
             text: str, superseded: bool) -> str:
    """Give a page one stable citation id, however many searches return it."""
    for key, existing in sources.items():
        if existing["doc_id"] == doc_id and existing["page"] == page:
            return key
    key = f"S{len(sources) + 1}"
    sources[key] = {
        "id": key,
        "doc_id": doc_id,
        "document": document,
        "page": page,
        "section": section,
        "snippet": text[:400],
        "superseded": superseded,
        "status": page_status(doc_id, page),
    }
    return key


def run_tool(name: str, args: dict, sources: dict) -> str:
    """Execute a tool call and register every hit as a citable source."""
    if name == "search_ffu":
        hits = search(args.get("query", ""), include_superseded=bool(args.get("include_superseded")))
        if not hits:
            return "Inga träffar. Pröva andra sökord."
        blocks = []
        for hit in hits:
            key = register(sources, hit["doc_id"], hit["page"], hit["section"],
                           hit["display_name"], hit["text"], bool(hit["superseded_by"]))
            flags = []
            if hit["superseded_by"]:
                flags.append("ERSATT VERSION")
            flags += page_status(hit["doc_id"], hit["page"])
            blocks.append(
                f"[{key}] {hit['display_name']} — sida {hit['page']}"
                + (f" — {hit['section']}" if hit["section"] else "")
                + (f" — {', '.join(flags)}" if flags else "")
                + f"\n{hit['text']}"
            )
        return "\n\n".join(blocks)

    if name == "read_page":
        row = db.execute(
            """SELECT p.text, d.display_name, d.superseded_by FROM pages p
               JOIN documents d ON d.id = p.doc_id WHERE p.doc_id=? AND p.page=?""",
            (args.get("doc_id"), args.get("page")),
        ).fetchone()
        if not row:
            return "Sidan finns inte."
        key = register(sources, args["doc_id"], args["page"], "", row["display_name"],
                       row["text"], bool(row["superseded_by"]))
        return f"[{key}] {row['display_name']} — sida {args['page']}\n{row['text'][:6000]}"

    return "Okänt verktyg."


def event(kind: str, **payload) -> str:
    return json.dumps({"type": kind, **payload}, ensure_ascii=False) + "\n"


def chat_stream(message: str, history: list[dict]):
    """Tool-calling loop; streams text, tool status and sources as NDJSON."""
    system = SYSTEM.format(documents=document_lines(), kfu=kfu_summary())
    messages = [{"role": "system", "content": system}, *history, {"role": "user", "content": message}]
    sources: dict = {}

    try:
        for _ in range(8):
            stream = client().chat.completions.create(
                model=MODEL, messages=messages, tools=TOOLS, tool_choice="auto", stream=True
            )
            content, calls = "", {}
            for part in stream:
                if not part.choices:
                    continue
                delta = part.choices[0].delta
                if delta.content:
                    content += delta.content
                    yield event("delta", text=delta.content)
                for call in delta.tool_calls or []:
                    entry = calls.setdefault(call.index, {"id": "", "name": "", "args": ""})
                    if call.id:
                        entry["id"] = call.id
                    if call.function and call.function.name:
                        entry["name"] += call.function.name
                    if call.function and call.function.arguments:
                        entry["args"] += call.function.arguments

            if not calls:
                yield event("done", sources=sources)
                return

            # Text written before a tool call is thinking-out-loud, not the answer.
            if content:
                yield event("reset")
            messages.append(
                {
                    "role": "assistant",
                    "content": content or None,
                    "tool_calls": [
                        {"id": c["id"], "type": "function", "function": {"name": c["name"], "arguments": c["args"]}}
                        for c in calls.values()
                    ],
                }
            )
            for call in calls.values():
                try:
                    args = json.loads(call["args"] or "{}")
                except json.JSONDecodeError:
                    args = {}
                label = args.get("query") or f"sida {args.get('page')}"
                yield event("status", text=f"Söker: {label}")
                result = run_tool(call["name"], args, sources)
                messages.append({"role": "tool", "tool_call_id": call["id"], "content": result})
                yield event("sources", sources=sources)

        yield event("done", sources=sources)
    except Exception as exc:  # network, key, model errors
        logger.exception("chat failed")
        yield event("error", text=str(exc))


# --------------------------------------------------------------------------
# endpoints
# --------------------------------------------------------------------------


@app.post("/api/chat")
def chat(body: dict):
    message = (body.get("message") or "").strip()
    if not message:
        raise HTTPException(400, "Tom fråga.")
    history = [m for m in body.get("history", []) if m.get("role") in ("user", "assistant")]
    return StreamingResponse(
        chat_stream(message, history[-10:]),
        media_type="application/x-ndjson",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.get("/api/documents")
def documents():
    rows = db.execute(
        """SELECT d.id, d.display_name, d.number, d.title, d.category, d.precedence,
                       d.rev_date, d.superseded_by, d.page_count, d.ext,
                       (SELECT COUNT(*) FROM marks m WHERE m.doc_id = d.id) AS marks
                FROM documents d ORDER BY d.precedence, d.number"""
    ).fetchall()
    return {"documents": [dict(row) for row in rows]}


@app.get("/api/changes")
def changes():
    """Everything the package tells us has changed — for review, not trust."""
    marks = db.execute(
        """SELECT m.doc_id, d.display_name, m.page, m.kind, m.text
           FROM marks m JOIN documents d ON d.id = m.doc_id
           ORDER BY d.number, m.page"""
    ).fetchall()
    kfu = db.execute(
        """SELECT k.target, k.kind, k.description, k.target_doc_id,
                  d.display_name AS kfu, t.display_name AS target_doc
           FROM kfu_changes k JOIN documents d ON d.id = k.kfu_id
           LEFT JOIN documents t ON t.id = k.target_doc_id ORDER BY d.number"""
    ).fetchall()
    superseded = db.execute(
        """SELECT o.id, o.display_name AS old_name, n.display_name AS new_name
           FROM documents o JOIN documents n ON n.id = o.superseded_by"""
    ).fetchall()
    return {
        "marks": [dict(r) for r in marks],
        "kfu": [dict(r) for r in kfu],
        "superseded": [dict(r) for r in superseded],
    }


@app.get("/api/documents/{doc_id}/pages/{page}")
def page_text(doc_id: int, page: int):
    row = db.execute("SELECT text FROM pages WHERE doc_id=? AND page=?", (doc_id, page)).fetchone()
    if not row:
        raise HTTPException(404, "Sidan finns inte.")
    return {"doc_id": doc_id, "page": page, "text": row["text"]}


@app.get("/api/files/{doc_id}")
def file(doc_id: int):
    row = db.execute("SELECT filename, display_name, ext FROM documents WHERE id=?", (doc_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Handlingen finns inte.")
    path = DATA_DIR / row["filename"]
    if not path.exists():
        raise HTTPException(404, "Filen saknas på disk.")
    return FileResponse(
        path,
        media_type="application/pdf" if row["ext"] == "pdf" else "application/octet-stream",
        filename=row["display_name"],
        content_disposition_type="inline",
    )


def _run_ingest():
    with _ingest_lock:
        _status.update(running=True, message="Läser handlingar…")
        try:
            summary = ingest.ingest(db, DATA_DIR, progress=lambda text: _status.update(message=text))
            _status.update(running=False, message="Klart", summary=summary)
        except Exception as exc:
            logger.exception("ingest failed")
            _status.update(running=False, message=f"Fel: {exc}")


@app.post("/api/process")
def process():
    if _status["running"]:
        return {"status": "running"}
    threading.Thread(target=_run_ingest, daemon=True).start()
    return {"status": "started"}


@app.post("/api/upload")
async def upload(file: UploadFile = File(...)):
    """Take an FFU package straight from the procurement system as a zip."""
    if not file.filename.lower().endswith(".zip"):
        raise HTTPException(400, "Ladda upp en .zip med förfrågningsunderlaget.")
    with tempfile.NamedTemporaryFile(delete=False, suffix=".zip") as tmp:
        shutil.copyfileobj(file.file, tmp)
        tmp_path = Path(tmp.name)
    try:
        for old in DATA_DIR.iterdir():
            if old.is_file():
                old.unlink()
        count = ingest.unpack_zip(tmp_path, DATA_DIR)
    finally:
        tmp_path.unlink(missing_ok=True)
    threading.Thread(target=_run_ingest, daemon=True).start()
    return {"status": "started", "files": count}


@app.get("/api/status")
def status():
    return {
        **_status,
        "documents": db.execute("SELECT COUNT(*) FROM documents").fetchone()[0],
        "pages": db.execute("SELECT COUNT(*) FROM pages").fetchone()[0],
        "marks": db.execute("SELECT COUNT(*) FROM marks").fetchone()[0],
    }


if FRONTEND_DIST.exists():  # production: one container serves API and UI
    app.mount("/", StaticFiles(directory=FRONTEND_DIST, html=True), name="frontend")