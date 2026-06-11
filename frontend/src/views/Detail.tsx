import { useState, useEffect, useRef } from "react";
import { useParams, useNavigate } from "react-router-dom";
import {
  getEntry,
  deleteEntry,
  updateImportTags,
  listTags,
} from "../api/client";
import type { Entry } from "../types";
import EntryTypeBadge from "../components/EntryTypeBadge";
import EntryRow from "../components/EntryRow";
import TagInput from "../components/TagInput";
import { useConfirm } from "../hooks/useConfirm";
import { renderWithChunkHighlight } from "../utils/textFormatting";

interface Props {
  toast: (msg: string, kind?: "success" | "error" | "info") => void;
}

interface HlCtx {
  query: string;
  matched_by?: string;
  matched_chunk_type?: string;
  snippet?: string;
}

export default function Detail({ toast }: Props) {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { confirmDialog, ask } = useConfirm();
  const [entry, setEntry] = useState<Entry | null>(null);
  const [loading, setLoading] = useState(true);
  const [hlCtx, setHlCtx] = useState<HlCtx | null>(null);
  const firstMarkRef = useRef<Element | null>(null);
  const [docTags, setDocTags] = useState<string[]>([]);
  const [allTags, setAllTags] = useState<string[]>([]);

  useEffect(() => {
    if (!id) return;
    const stored = sessionStorage.getItem(`highlight-${id}`);
    if (stored) {
      try {
        setHlCtx(JSON.parse(stored));
      } catch {}
    }
    getEntry(Number(id))
      .then(setEntry)
      .catch(() => toast("Eintrag nicht gefunden", "error"))
      .finally(() => setLoading(false));
  }, [id]);

  useEffect(() => {
    if (!entry || !hlCtx) return;
    const el = firstMarkRef.current;
    if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [entry, hlCtx]);

  useEffect(() => {
    if (!entry || entry.entry_type === "qa") return;
    setDocTags(entry.tags);
    listTags()
      .then(({ tags }) => setAllTags(tags.map((t) => t.name)))
      .catch(() => {});
  }, [entry]);

  const handleDocTagChange = async (tags: string[]) => {
    if (!entry) return;
    setDocTags(tags);
    await updateImportTags(entry.id, tags).catch(() =>
      toast("Tags konnten nicht gespeichert werden", "error"),
    );
  };

  const handleDelete = async () => {
    if (!entry || !(await ask("Eintrag wirklich löschen?"))) return;
    await deleteEntry(entry.id);
    toast("Eintrag gelöscht", "success");
    navigate(-1);
  };

  if (loading)
    return (
      <main className="pb-main">
        <div className="empty">
          <p>Lädt…</p>
        </div>
      </main>
    );
  if (!entry)
    return (
      <main className="pb-main">
        <div className="empty">
          <h3>Nicht gefunden</h3>
        </div>
      </main>
    );

  const isQA = entry.entry_type === "qa";
  const mct = hlCtx?.matched_chunk_type;
  const snippet = hlCtx?.snippet;

  const hl = (text: string | null) => {
    if (!text || !snippet) return text;
    return renderWithChunkHighlight(text, snippet, firstMarkRef);
  };

  return (
    <main className="pb-main">
      <button className="detail-back" onClick={() => navigate(-1)}>
        ← Zurück
      </button>

      <div className="detail">
        <div>
          <div className="detail-meta-row" style={{ marginBottom: 10 }}>
            <EntryTypeBadge type={entry.entry_type} />
            {isQA ? (
              entry.tags.map((t) => (
                <span className="chip" key={t}>
                  {t}
                </span>
              ))
            ) : (
              <TagInput
                tags={docTags}
                onChange={handleDocTagChange}
                suggestions={allTags}
              />
            )}
            <span
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 10,
                marginLeft: 4,
              }}
            >
              {entry.call_count}× aufgerufen
            </span>
          </div>
          <h1>
            {mct === "title"
              ? hl(entry.display_title || null)
              : entry.display_title}
          </h1>
        </div>

        {isQA ? (
          <>
            {entry.question && (
              <div className="detail-section">
                <div className="detail-section-label">Frage</div>
                <div className="detail-body">
                  {mct === "question" ? hl(entry.question) : entry.question}
                </div>
              </div>
            )}
            {entry.answer && (
              <div className="detail-section">
                <div className="detail-section-label">Antwort</div>
                <div className="detail-body">
                  {mct === "answer" || mct === "content"
                    ? hl(entry.answer)
                    : entry.answer}
                </div>
              </div>
            )}
          </>
        ) : (
          <div className="detail-section">
            {entry.source_filename && (
              <div className="detail-meta-row" style={{ marginBottom: 10 }}>
                <span style={{ fontSize: 11, color: "var(--primary--500)" }}>
                  📄 {entry.source_filename}
                </span>
              </div>
            )}
            <div className="detail-body">{hl(entry.content)}</div>
          </div>
        )}

        <div className="detail-actions">
          <button
            className="btn btn--ghost"
            onClick={() => navigate(`/editor/${entry.id}`)}
          >
            Bearbeiten
          </button>
          <button
            className="btn btn--ghost"
            onClick={handleDelete}
            style={{ marginLeft: "auto" }}
          >
            Löschen
          </button>
        </div>
      </div>

      {entry.related && entry.related.length > 0 && (
        <div className="related">
          <h4>Verwandte Einträge</h4>
          <div className="entry-list">
            {entry.related.map((r) => (
              <EntryRow
                key={r.id}
                title={r.display_title || ""}
                entry_type={r.entry_type}
                onClick={() => navigate(`/entries/${r.id}`)}
              />
            ))}
          </div>
        </div>
      )}
      {confirmDialog}
    </main>
  );
}
