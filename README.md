# FFU Analyzer

Ask questions about a Swedish tender package (*förfrågningsunderlag*) and get answers
with a source and a page number, plus a warning when the text has been changed or
removed by a later revision.

Requirements: Python 3.12+ and Node 24+.

---

## What I built

### 1. Page-level retrieval with citations

The original app handed the model a list of filenames and let it pull whole documents
into context. This version indexes every page of every document (PDF and Excel),
splits text at AMA and AF codes, and searches with SQLite FTS5. Each claim in an
answer carries a citation you can click, which opens the PDF at that page.

### 2. Change tracking

The package contains three documents in two versions, plus two change memos
(*ändrings-PM*, KFU 1 and KFU 2) issued during the tender period. KFU 1 states the
convention used in the revised documents: changes are marked in yellow, and
struck-through text no longer applies.

Text extraction cannot see strikethrough, so a plain text pipeline reads deleted
requirements as if they were still binding. This app detects the marks in the PDF
itself:

- Struck text is indexed as `[STRUKEN — utgår enligt revidering]`.
- Highlighted and red text is indexed as `[ÄNDRAD i revidering]`.
- Older versions are linked to the newer ones and left out of answers by default.
- Each KFU is linked to the documents it changes.

Across the 585 pages of this package the detector finds 122 marks, all inside the
three revised documents.

**Worked example: "Krävs YPK-packningskontroll?"**

The requirement for YPK compaction testing appears twice in document 10.1. Under
CEB.11222 it still applies. Under CEB.1123 it is crossed out on page 47. The app
answers "yes for roads and turning areas, no for the struck text" and marks the page
47 citation in red. An app that reads only the text answers "yes" to both, and the
estimator prices testing that the client removed.

### 3. A reviewable interface

- **Handlingar**: every document with its status (current, revised, superseded),
  listed in precedence order with the change memos first, following AFB.32 and AFB.33
  in the AF.
- **Ändringar**: every detected mark and every KFU entry, each one clickable, so a
  user can check the app's claims against the PDF in a couple of minutes.
- **Källa**: the PDF opened at the cited page.
- **Upload**: drop in the tender zip as downloaded from the procurement system.
  Filenames mangled by Mac-to-Windows zip extraction are repaired on the way in.

---

## Why I built it

The user is an estimator (*kalkylator*) pricing a fixed-price contract under AB 04.
Two mistakes cost real money:

- Missing a deletion means pricing work that is no longer required, so the bid comes
  in too high and the tender is lost.
- Missing an addition or a changed quantity means the bid comes in too low, so the job
  is won at a loss.

The only safeguard today is someone comparing 127-page documents by hand under
deadline pressure. Citations make an answer verifiable. Change tracking makes it
current. Both are needed before anyone would trust the tool with a bid.

---

## Getting started

1. Put your API key in `.env` in the repo root:

   ```env
   OPENAI_API_KEY=your-key-here
   ```

2. Unzip the FFU files into `backend/data`, or upload the zip in the app once it runs.

3. Start the backend:

   ```bash
   cd backend
   pip install -r requirements.txt
   python ingest.py          # builds the index and prints marks found per document
   python -m uvicorn main:app --reload --host 127.0.0.1 --port 8000
   ```

4. In a second terminal, start the frontend:

   ```bash
   cd frontend
   npm install
   npm run dev
   ```

5. Open `http://localhost:5173` and ask a question. Use **Ladda upp FFU (.zip)** to
   load a different package.

### Deployment

The Dockerfile builds the frontend and serves it from FastAPI in one container. On
Railway: set `OPENAI_API_KEY`, mount a volume at `/data`, then upload the zip in the
app.

Notes on the hosted version:

- The tender documents are not in the repository, so the app starts empty. Upload the
  zip once and it is indexed in a minute or two. Uploading a 30 MB package takes
  longer over the network than it does locally.
- The volume at `/data` holds both the documents and the index, so they survive
  restarts and redeploys. Without it, every redeploy leaves the app empty.
- The instance is shared. Anyone with the link can ask questions, every question
  spends API credit, and uploading a new package replaces the documents for everyone.
  That is fine for a review, but it would need per-user storage and authentication
  before real use.

---

## Limitations

The change detection is a set of rules, not intelligence, so it is worth being
explicit about what it does not do:

- It recognises this package's marking convention: yellow highlight, strikethrough and
  red text. Revision clouds on drawings and changes described only in a written list
  are missed.
- Marks are only interpreted in documents carrying a revision date, because
  highlighting is used for other purposes elsewhere. The Arbetsmiljöplan, for example,
  highlights blank fields to be filled in.
- Detection is geometric: a line crossing the middle of a word counts as a strike.
  Table rules were an early false positive and are now filtered out by width, but other
  layouts may still produce noise. The Ändringar tab exists so a user can check every
  mark.
- Drawings are indexed by their text only. Their graphical content is not read.
- Retrieval is keyword-based (BM25). It is strong on AMA codes and Swedish technical
  terms, weaker on paraphrased questions.

The app flags pages for review. It does not guarantee correctness, and an estimator
should still confirm anything that affects a price.

---

## What I would do next

1. **Hybrid retrieval.** Add embeddings alongside BM25 so paraphrased questions work
   as well as exact codes. This was left out deliberately: with limited time, change
   tracking was worth more than a second retrieval method.
2. **Compare the old and new versions directly.** Both versions of 10.1 are in the
   package, so a text comparison would catch changes carrying no visual mark at all,
   which is the biggest hole in the current approach.
3. **A tender overview** with deadlines, mandatory requirements, penalties (*viten*)
   and risks in a dashboard, each item citing its page. The retrieval layer already
   supports it.
4. **An evaluation set** of roughly 20 questions with verified answers, including
   revision cases, run against every change. Right now the evidence is a handful of
   manually checked examples.
5. **Read the drawings** with a vision model, and report inconsistencies found along
   the way. KFU 1 refers to "6.1 Avsteg MER Anläggning 20" while the package contains
   6.3 based on MER 23, and the AF lists documents (13.2, 13.4, 13.8) that are not
   included. Those are questions a bidder should put to the client.