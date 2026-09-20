import { FormEvent, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

type Source = {
  id: string
  doc_id: number
  document: string
  page: number
  section: string
  snippet: string
  superseded: boolean
  status: string[]
}

type Message = { role: 'user' | 'assistant'; content: string; sources?: Record<string, Source> }

type Doc = {
  id: number
  display_name: string
  number: string | null
  category: string
  rev_date: string | null
  superseded_by: number | null
  page_count: number
  marks: number
  ext: string
}

type Mark = { doc_id: number; display_name: string; page: number; kind: string; text: string }
type Kfu = { kfu: string; target: string; description: string; target_doc: string | null }

const api = (path: string, init?: RequestInit) => fetch(`/api${path}`, init)

function App() {
  const [docs, setDocs] = useState<Doc[]>([])
  const [marks, setMarks] = useState<Mark[]>([])
  const [kfu, setKfu] = useState<Kfu[]>([])
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)
  const [tab, setTab] = useState<'docs' | 'changes' | 'source'>('docs')
  const [source, setSource] = useState<Source | null>(null)
  const [processing, setProcessing] = useState(false)
  const chatEnd = useRef<HTMLDivElement>(null)

  const load = async () => {
    const [d, c] = await Promise.all([
      api('/documents').then((r) => r.json()),
      api('/changes').then((r) => r.json()),
    ])
    setDocs(d.documents)
    setMarks(c.marks)
    setKfu(c.kfu)
  }

  useEffect(() => {
    load().catch(() => setStatus('Kunde inte nå servern.'))
  }, [])

  useEffect(() => {
    chatEnd.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // Poll while the package is being indexed.
  useEffect(() => {
    if (!processing) return
    const timer = setInterval(async () => {
      const s = await api('/status').then((r) => r.json())
      setStatus(s.message)
      if (!s.running) {
        setProcessing(false)
        load()
      }
    }, 1500)
    return () => clearInterval(timer)
  }, [processing])

  const process = async () => {
    await api('/process', { method: 'POST' })
    setProcessing(true)
    setStatus('Läser handlingar…')
  }

  const upload = async (file: File) => {
    const body = new FormData()
    body.append('file', file)
    setStatus('Laddar upp…')
    const res = await api('/upload', { method: 'POST', body })
    if (!res.ok) {
      setStatus('Uppladdningen misslyckades.')
      return
    }
    setProcessing(true)
  }

  const send = async (e: FormEvent) => {
    e.preventDefault()
    const question = input.trim()
    if (!question || busy) return

    const history = messages.map((m) => ({ role: m.role, content: m.content }))
    setMessages([...messages, { role: 'user', content: question }, { role: 'assistant', content: '' }])
    setInput('')
    setBusy(true)
    setStatus('')

    try {
      const res = await api('/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: question, history }),
      })
      if (!res.body) throw new Error('Ingen svarsström.')

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let answer = ''

      const update = (patch: Partial<Message>) =>
        setMessages((current) => {
          const next = [...current]
          next[next.length - 1] = { ...next[next.length - 1], ...patch }
          return next
        })

      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.trim()) continue
          const event = JSON.parse(line)
          if (event.type === 'delta') {
            answer += event.text
            update({ content: answer })
          } else if (event.type === 'reset') {
            answer = ''
            update({ content: '' })
          } else if (event.type === 'status') {
            setStatus(event.text)
          } else if (event.type === 'sources' || event.type === 'done') {
            update({ sources: event.sources })
          } else if (event.type === 'error') {
            answer += `\n\n_Fel: ${event.text}_`
            update({ content: answer })
          }
        }
      }
    } catch (error) {
      setMessages((current) => {
        const next = [...current]
        next[next.length - 1] = { role: 'assistant', content: `_Fel: ${(error as Error).message}_` }
        return next
      })
    } finally {
      setBusy(false)
      setStatus('')
    }
  }

  const openSource = (s: Source) => {
    setSource(s)
    setTab('source')
  }

  const current = docs.filter((d) => !d.superseded_by)
  const replaced = docs.filter((d) => d.superseded_by)

  return (
    <div className="app">
      <header>
        <div>
          <strong>FFU Analyzer</strong>
          <span className="sub">
            {docs.length} handlingar · {marks.length} ändringsmarkeringar · {replaced.length} ersatta
          </span>
        </div>
        <div className="actions">
          <label className="btn">
            Ladda upp FFU (.zip)
            <input
              type="file"
              accept=".zip"
              hidden
              onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])}
            />
          </label>
          <button className="btn" onClick={process} disabled={processing}>
            {processing ? 'Bearbetar…' : 'Bearbeta om'}
          </button>
        </div>
      </header>

      <main>
        <section className="chat">
          <div className="messages">
            {messages.length === 0 && (
              <div className="empty">
                <p>Fråga om förfrågningsunderlaget. Svaren anger källa med sidnummer.</p>
                <ul>
                  {[
                    'Krävs YPK-packningskontroll?',
                    'Vilket vite gäller vid försening?',
                    'Vad ändrades i KFU 2?',
                  ].map((q) => (
                    <li key={q}>
                      <button className="chip" onClick={() => setInput(q)}>
                        {q}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {messages.map((message, index) => (
              <div key={index} className={`msg ${message.role}`}>
                {message.role === 'assistant' ? (
                  <Answer message={message} onCite={openSource} />
                ) : (
                  message.content
                )}
              </div>
            ))}

            {busy && <div className="msg assistant thinking">{status || 'Tänker…'}</div>}
            <div ref={chatEnd} />
          </div>

          <form onSubmit={send}>
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Fråga om handlingarna…"
            />
            <button className="btn primary" disabled={busy}>
              Skicka
            </button>
          </form>
        </section>

        <aside>
          <nav>
            {(
              [
                ['docs', `Handlingar (${docs.length})`],
                ['changes', `Ändringar (${marks.length + kfu.length})`],
                ['source', 'Källa'],
              ] as const
            ).map(([key, label]) => (
              <button key={key} className={tab === key ? 'active' : ''} onClick={() => setTab(key)}>
                {label}
              </button>
            ))}
          </nav>

          {tab === 'docs' && (
            <div className="panel">
              {status && <p className="status">{status}</p>}
              <h3>Gällande handlingar</h3>
              {current.map((d) => (
                <DocRow key={d.id} doc={d} onOpen={() => openSource(asSource(d))} />
              ))}
              {replaced.length > 0 && <h3>Ersatta versioner</h3>}
              {replaced.map((d) => (
                <DocRow key={d.id} doc={d} onOpen={() => openSource(asSource(d))} />
              ))}
            </div>
          )}

          {tab === 'changes' && (
            <div className="panel">
              <p className="note">
                Ändrings-PM och markeringar i reviderade handlingar. Gul markering = ändrad text,
                genomstruken = utgår. Kontrollera alltid mot originalhandlingen.
              </p>
              <h3>Ändrings-PM (KFU)</h3>
              {kfu.map((k, i) => (
                <div className="row" key={i}>
                  <div className="row-main">{k.description}</div>
                  <div className="row-sub">
                    {k.kfu} → {k.target_doc ?? `${k.target} (saknas i paketet)`}
                  </div>
                </div>
              ))}
              <h3>Markeringar i reviderade handlingar</h3>
              {marks.map((m, i) => (
                <button
                  className="row clickable"
                  key={i}
                  onClick={() =>
                    openSource({
                      id: '',
                      doc_id: m.doc_id,
                      document: m.display_name,
                      page: m.page,
                      section: '',
                      snippet: m.text,
                      superseded: false,
                      status: [],
                    })
                  }
                >
                  <div className="row-main">
                    <span className={`tag ${m.kind}`}>
                      {m.kind === 'struck' ? 'utgår' : m.kind === 'red' ? 'röd text' : 'ändrad'}
                    </span>
                    {m.text}
                  </div>
                  <div className="row-sub">
                    {m.display_name} — sida {m.page}
                  </div>
                </button>
              ))}
            </div>
          )}

          {tab === 'source' && (
            <div className="panel viewer">
              {!source && <p className="note">Klicka på en källhänvisning i ett svar.</p>}
              {source && (
                <>
                  <div className="source-head">
                    <strong>{source.document}</strong>
                    <span className="row-sub">
                      Sida {source.page}
                      {source.section ? ` · ${source.section}` : ''}
                      {source.superseded ? ' · ERSATT VERSION' : ''}
                    </span>
                    {source.status?.map((s) => (
                      <span className="tag struck" key={s}>
                        {s}
                      </span>
                    ))}
                  </div>
                  {source.snippet && <pre className="snippet">{source.snippet}</pre>}
                  <iframe
                    key={`${source.doc_id}-${source.page}`}
                    title="källa"
                    src={`/api/files/${source.doc_id}#page=${source.page}`}
                  />
                </>
              )}
            </div>
          )}
        </aside>
      </main>
    </div>
  )
}

function asSource(doc: Doc): Source {
  return {
    id: '',
    doc_id: doc.id,
    document: doc.display_name,
    page: 1,
    section: '',
    snippet: '',
    superseded: !!doc.superseded_by,
    status: [],
  }
}

function DocRow({ doc, onOpen }: { doc: Doc; onOpen: () => void }) {
  return (
    <button className="row clickable" onClick={onOpen}>
      <div className="row-main">{doc.display_name}</div>
      <div className="row-sub">
        {doc.category} · {doc.page_count} sidor
        {doc.rev_date && <span className="tag rev">rev {doc.rev_date}</span>}
        {doc.superseded_by && <span className="tag old">ersatt</span>}
        {doc.marks > 0 && <span className="tag change">{doc.marks} ändringar</span>}
      </div>
    </button>
  )
}

/** Renders the answer and turns [S1] into a button that opens the page. */
function Answer({ message, onCite }: { message: Message; onCite: (s: Source) => void }) {
  const sources = message.sources ?? {}
  const withLinks = message.content.replace(/\[(S\d+)\]/g, (match, id) =>
    sources[id] ? `[${id}](#cite-${id})` : match,
  )
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ href, children }) => {
          const id = href?.startsWith('#cite-') ? href.slice(6) : null
          const source = id ? sources[id] : null
          if (!source) return <a href={href}>{children}</a>
          const struck = source.status?.some((s) => s.includes('utgår'))
          return (
            <button
              className={`cite ${struck ? 'warn' : ''}`}
              title={`${source.document} — sida ${source.page}`}
              onClick={() => onCite(source)}
            >
              {source.document.slice(0, 18)}… s.{source.page}
              {struck && ' ⚠'}
            </button>
          )
        },
      }}
    >
      {withLinks}
    </ReactMarkdown>
  )
}

const css = `
* { box-sizing: border-box; }
body { margin: 0; font: 15px/1.55 system-ui, sans-serif; color: #17202a; background: #eef1f4; }
.app { height: 100vh; display: flex; flex-direction: column; }
header { display: flex; justify-content: space-between; align-items: center; gap: 16px;
  padding: 12px 20px; background: #fff; border-bottom: 1px solid #d9dfe5; }
header .sub { margin-left: 12px; color: #5b6b7c; font-size: 13px; }
.actions { display: flex; gap: 8px; }
.btn { border: 1px solid #c3ccd6; background: #fff; padding: 8px 12px; border-radius: 6px;
  font: inherit; cursor: pointer; }
.btn:hover { background: #f3f6f9; }
.btn.primary { background: #16324f; color: #fff; border-color: #16324f; }
.btn:disabled { opacity: .55; cursor: default; }
main { flex: 1; display: grid; grid-template-columns: minmax(0, 1fr) minmax(360px, 42%); min-height: 0; }
.chat { display: flex; flex-direction: column; min-height: 0; border-right: 1px solid #d9dfe5; }
.messages { flex: 1; overflow: auto; padding: 20px; display: flex; flex-direction: column; gap: 14px; }
.msg { max-width: 92%; padding: 12px 14px; border-radius: 10px; white-space: pre-wrap; }
.msg.user { align-self: flex-end; background: #16324f; color: #fff; }
.msg.assistant { align-self: flex-start; background: #fff; border: 1px solid #e1e6eb; white-space: normal; }
.msg.assistant p:first-child { margin-top: 0; }
.msg.assistant p:last-child { margin-bottom: 0; }
.msg.thinking { color: #5b6b7c; font-style: italic; }
.empty { color: #5b6b7c; }
.empty ul { list-style: none; padding: 0; display: flex; flex-wrap: wrap; gap: 8px; }
.chip { border: 1px solid #c3ccd6; background: #fff; border-radius: 999px; padding: 6px 12px;
  font: inherit; cursor: pointer; }
form { display: flex; gap: 8px; padding: 14px 20px; border-top: 1px solid #d9dfe5; background: #fff; }
form input { flex: 1; padding: 10px 12px; border: 1px solid #c3ccd6; border-radius: 6px; font: inherit; }
.cite { border: 1px solid #b8cbe0; background: #eaf2fa; color: #16324f; border-radius: 4px;
  padding: 1px 6px; font-size: 12px; cursor: pointer; margin: 0 2px; }
.cite.warn { background: #fdecea; border-color: #f0b7b2; color: #8a2b22; }
aside { display: flex; flex-direction: column; min-height: 0; background: #fff; }
aside nav { display: flex; border-bottom: 1px solid #d9dfe5; }
aside nav button { flex: 1; padding: 11px 8px; border: 0; background: none; font: inherit;
  cursor: pointer; color: #5b6b7c; border-bottom: 2px solid transparent; }
aside nav button.active { color: #16324f; font-weight: 600; border-bottom-color: #16324f; }
.panel { flex: 1; overflow: auto; padding: 14px 16px; }
.panel h3 { font-size: 12px; text-transform: uppercase; letter-spacing: .05em; color: #5b6b7c;
  margin: 18px 0 8px; }
.row { display: block; width: 100%; text-align: left; border: 0; border-bottom: 1px solid #eef1f4;
  background: none; padding: 9px 0; font: inherit; }
.row.clickable { cursor: pointer; }
.row.clickable:hover { background: #f5f8fb; }
.row-main { font-size: 14px; }
.row-sub { font-size: 12px; color: #5b6b7c; margin-top: 3px; display: flex; flex-wrap: wrap;
  gap: 6px; align-items: center; }
.tag { border-radius: 4px; padding: 1px 6px; font-size: 11px; }
.tag.rev { background: #e7f0fa; color: #1c4a7a; }
.tag.old { background: #ece9f5; color: #4b3b78; }
.tag.change, .tag.highlight { background: #fdf4d6; color: #7a5a14; }
.tag.struck { background: #fdecea; color: #8a2b22; }
.tag.red { background: #fdecea; color: #8a2b22; }
.note, .status { font-size: 13px; color: #5b6b7c; }
.viewer { display: flex; flex-direction: column; gap: 10px; }
.source-head { display: flex; flex-direction: column; gap: 4px; }
.snippet { background: #f5f8fb; border: 1px solid #e1e6eb; border-radius: 6px; padding: 10px;
  font-size: 12px; white-space: pre-wrap; max-height: 150px; overflow: auto; margin: 0; }
.viewer iframe { flex: 1; min-height: 420px; width: 100%; border: 1px solid #e1e6eb; border-radius: 6px; }
@media (max-width: 900px) { main { grid-template-columns: 1fr; } aside { display: none; } }
`

const style = document.createElement('style')
style.textContent = css
document.head.appendChild(style)

createRoot(document.getElementById('root')!).render(<App />)
