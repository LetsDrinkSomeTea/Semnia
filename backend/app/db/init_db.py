import json
from sqlalchemy import text
from app.db.session import Base, engine, SessionLocal
from app.db.models import Entry, EntryTag, Chunk, Setting
from app.config import DEFAULT_SETTINGS, SETTINGS_OVERRIDES


SEED_QA = [
    {
        "question": "Wie beantrage ich Urlaub?",
        "answer": "Urlaubsanträge werden über das HR-Portal eingereicht. Mindestvorlaufzeit: 2 Wochen. Bei Abwesenheit über 5 Tage Rücksprache mit Teamleitung erforderlich.",
        "tags": ["HR", "Prozesse"],
    },
    {
        "question": "Wo finde ich die VPN-Zugangsdaten?",
        "answer": "VPN-Konfigurationsdateien liegen im internen Wiki unter IT → VPN. Bei Problemen: IT-Helpdesk über #it-support auf Slack.",
        "tags": ["IT", "Sicherheit"],
    },
    {
        "question": "Wie wird Code-Review durchgeführt?",
        "answer": "Jeder Pull Request benötigt mindestens ein Approval. Reviews sollen binnen 24h erfolgen. Checkliste: Funktionalität, Tests, Lesbarkeit, Dokumentation.",
        "tags": ["Entwicklung", "Prozesse"],
    },
    {
        "question": "Was ist die Bereitschaftsregelung?",
        "answer": "Bereitschaft rotiert wöchentlich. Ablösung jeden Montag 09:00 Uhr. Vergütung: 1,5× Stundenlohn für tatsächliche Einsätze.",
        "tags": ["HR", "Betrieb"],
    },
    {
        "question": "Wie melde ich einen Produktionsfehler?",
        "answer": "1. Slack #incidents benachrichtigen. 2. Jira-Ticket mit Priorität Critical anlegen. 3. Stakeholder per E-Mail informieren. 4. Post-Mortem innerhalb von 48h.",
        "tags": ["Betrieb", "Prozesse"],
    },
    {
        "question": "Wo werden Deployments dokumentiert?",
        "answer": "Jedes Deployment wird im Deployment-Log auf Confluence festgehalten: Datum, Version, Deployer, Änderungen, Rollback-Plan.",
        "tags": ["Entwicklung", "Betrieb"],
    },
    {
        "question": "Wie läuft das Onboarding für neue Entwickler?",
        "answer": "Woche 1: Setup & Systemzugänge. Woche 2: Einführung Codebase & Architektur. Woche 3: Erstes Ticket. Buddy-System: jeder Neue bekommt einen Mentor für 4 Wochen.",
        "tags": ["HR", "Entwicklung"],
    },
    {
        "question": "Welche Passwort-Policy gilt?",
        "answer": "Mindestens 12 Zeichen, Groß-/Kleinschreibung + Sonderzeichen. Passwort-Manager (Bitwarden) wird vom Unternehmen gestellt.",
        "tags": ["IT", "Sicherheit"],
    },
]


def _get_schema_version(conn) -> int:
    try:
        row = conn.execute(text("SELECT value FROM settings WHERE key='db_schema_version'")).fetchone()
        return int(json.loads(row[0])) if row else 0
    except Exception:
        return 0


def _set_schema_version(conn, version: int) -> None:
    conn.execute(
        text("INSERT OR REPLACE INTO settings(key, value) VALUES ('db_schema_version', :v)"),
        {"v": json.dumps(version)},
    )
    conn.commit()


def _normalize(text: str) -> str:
    """Local copy — avoids circular import from search.bm25 at migration time."""
    return (
        text.lower()
        .replace('ä', 'ae')
        .replace('ö', 'oe')
        .replace('ü', 'ue')
        .replace('ß', 'ss')
    )


def _run_migrations(conn) -> None:
    ver = _get_schema_version(conn)

    if ver < 1:
        # Add chunk_type column (new installs already have it via create_all; this handles upgrades)
        try:
            conn.execute(text("ALTER TABLE chunks ADD COLUMN chunk_type TEXT NOT NULL DEFAULT 'content'"))
        except Exception:
            pass  # column already exists

        # Drop old unicode61 FTS table and recreate with trigram tokenizer
        conn.execute(text("DROP TABLE IF EXISTS entries_fts"))
        conn.execute(text("""
            CREATE VIRTUAL TABLE entries_fts USING fts5(
                title, question, answer, content,
                tokenize='trigram'
            )
        """))
        conn.commit()

        # Re-populate FTS from entries (may be empty on fresh install)
        try:
            rows = conn.execute(
                text("SELECT id, title, question, answer, content FROM entries")
            ).fetchall()
            for row in rows:
                conn.execute(
                    text("INSERT INTO entries_fts(rowid, title, question, answer, content) VALUES (:id,:t,:q,:a,:c)"),
                    {"id": row[0], "t": row[1] or "", "q": row[2] or "", "a": row[3] or "", "c": row[4] or ""},
                )
            conn.commit()
        except Exception:
            pass

        _set_schema_version(conn, 1)
    if ver < 2:
        # Migration 2: re-populate entries_fts with umlaut-normalized text
        try:
            rows = conn.execute(text("SELECT id, title, question, answer, content FROM entries")).fetchall()
            conn.execute(text("DELETE FROM entries_fts"))
            for row in rows:
                conn.execute(
                    text("INSERT INTO entries_fts(rowid, title, question, answer, content) VALUES (:id,:t,:q,:a,:c)"),
                    {"id": row[0], "t": _normalize(row[1] or ""), "q": _normalize(row[2] or ""),
                     "a": _normalize(row[3] or ""), "c": _normalize(row[4] or "")},
                )
            conn.commit()
        except Exception:
            pass
        _set_schema_version(conn, 2)
    else:
        # Ensure FTS table exists (already trigram + normalized for ver >= 1)
        conn.execute(text("""
            CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
                title, question, answer, content, tags,
                tokenize='trigram'
            )
        """))
        conn.commit()

    if ver < 3:
        # Migration 3: update threshold defaults changed in the mpnet model switch
        # Only touches rows whose value still equals the old default — user-customised values are left as-is.
        try:
            conn.execute(text(
                "UPDATE settings SET value = '0.3' WHERE key = 'search_threshold' AND value = '0.2'"
            ))
            conn.execute(text(
                "UPDATE settings SET value = '0.9' WHERE key = 'dupe_threshold' AND value = '0.92'"
            ))
            conn.commit()
        except Exception:
            pass
        _set_schema_version(conn, 3)

    if ver < 4:
        # Migration 4: add tags column to FTS, create tag/title chunks for existing entries
        try:
            # FTS5 doesn't support ALTER TABLE — drop and recreate with tags column
            conn.execute(text("DROP TABLE IF EXISTS entries_fts"))
            conn.execute(text("""
                CREATE VIRTUAL TABLE entries_fts USING fts5(
                    title, question, answer, content, tags,
                    tokenize='trigram'
                )
            """))
            rows = conn.execute(text("SELECT id, title, question, answer, content, tags FROM entries")).fetchall()
            for row in rows:
                tags_text = _normalize(" ".join(json.loads(row[5] or "[]")))
                conn.execute(
                    text("INSERT INTO entries_fts(rowid, title, question, answer, content, tags) VALUES (:id,:t,:q,:a,:c,:tags)"),
                    {"id": row[0], "t": _normalize(row[1] or ""), "q": _normalize(row[2] or ""),
                     "a": _normalize(row[3] or ""), "c": _normalize(row[4] or ""), "tags": tags_text},
                )
            conn.commit()
        except Exception:
            pass

        try:
            # Create tag chunks for entries that have tags but no tag chunk yet
            entries = conn.execute(text("SELECT id, tags FROM entries")).fetchall()
            for eid, tags_json in entries:
                tags_list = json.loads(tags_json or "[]")
                if not tags_list:
                    continue
                existing = conn.execute(
                    text("SELECT id FROM chunks WHERE entry_id=:eid AND chunk_type='tag'"), {"eid": eid}
                ).fetchone()
                if existing:
                    continue
                max_idx = conn.execute(
                    text("SELECT COALESCE(MAX(chunk_index), -1) FROM chunks WHERE entry_id=:eid"), {"eid": eid}
                ).fetchone()[0]
                conn.execute(
                    text("INSERT INTO chunks(entry_id, chunk_index, chunk_type, content) VALUES (:eid,:idx,'tag',:content)"),
                    {"eid": eid, "idx": max_idx + 1, "content": " ".join(tags_list)},
                )
            conn.commit()
        except Exception:
            pass

        try:
            # Create title chunks for document entries that don't have one yet
            docs = conn.execute(
                text("SELECT id, title FROM entries WHERE entry_type='document'")
            ).fetchall()
            for eid, title in docs:
                if not title:
                    continue
                existing = conn.execute(
                    text("SELECT id FROM chunks WHERE entry_id=:eid AND chunk_type='title'"), {"eid": eid}
                ).fetchone()
                if existing:
                    continue
                conn.execute(
                    text("INSERT INTO chunks(entry_id, chunk_index, chunk_type, content) VALUES (:eid,0,'title',:content)"),
                    {"eid": eid, "content": title},
                )
            conn.commit()
        except Exception:
            pass

        _set_schema_version(conn, 4)

    if ver < 5:
        # Migration 5: remove tag chunks from vector index — tags are BM25-only
        try:
            tag_chunk_ids = [row[0] for row in conn.execute(
                text("SELECT id FROM chunks WHERE chunk_type='tag'")
            ).fetchall()]
            for cid in tag_chunk_ids:
                try:
                    conn.execute(text("DELETE FROM chunks_vec WHERE rowid=:id"), {"id": cid})
                except Exception:
                    pass
            conn.execute(text("DELETE FROM chunks WHERE chunk_type='tag'"))
            conn.commit()
        except Exception:
            pass
        _set_schema_version(conn, 5)

    if ver < 6:
        # Migration 6: re-chunk all entries with new smaller defaults (200 chars / 40 overlap).
        # Also updates the stored settings if they still hold the old defaults.
        _CS, _CO = 200, 40
        try:
            from app.import_.chunker import chunk_text as _chunk_text
            all_chunk_ids = [r[0] for r in conn.execute(text("SELECT id FROM chunks")).fetchall()]
            for cid in all_chunk_ids:
                try:
                    conn.execute(text("DELETE FROM chunks_vec WHERE rowid=:id"), {"id": cid})
                except Exception:
                    pass
            conn.execute(text("DELETE FROM chunks"))
            conn.commit()

            rows = conn.execute(
                text("SELECT id, entry_type, title, question, answer, content FROM entries")
            ).fetchall()
            for eid, etype, title, question, answer, content in rows:
                idx = 0
                if title and etype == "qa":
                    conn.execute(
                        text("INSERT INTO chunks(entry_id,chunk_index,chunk_type,content) VALUES(:e,:i,'title',:c)"),
                        {"e": eid, "i": idx, "c": title},
                    )
                    idx += 1
                if etype == "qa":
                    if question:
                        conn.execute(
                            text("INSERT INTO chunks(entry_id,chunk_index,chunk_type,content) VALUES(:e,:i,'question',:c)"),
                            {"e": eid, "i": idx, "c": question},
                        )
                        idx += 1
                    for ac in (_chunk_text(answer or "", max_chars=_CS, overlap_chars=_CO) or [answer or ""]):
                        conn.execute(
                            text("INSERT INTO chunks(entry_id,chunk_index,chunk_type,content) VALUES(:e,:i,'answer',:c)"),
                            {"e": eid, "i": idx, "c": ac},
                        )
                        idx += 1
                else:
                    for cc in (_chunk_text(content or "", max_chars=_CS, overlap_chars=_CO) or [content or ""]):
                        conn.execute(
                            text("INSERT INTO chunks(entry_id,chunk_index,chunk_type,content) VALUES(:e,:i,'content',:c)"),
                            {"e": eid, "i": idx, "c": cc},
                        )
                        idx += 1
            conn.commit()

            # Update stored settings only if they still hold the previous defaults
            conn.execute(text("UPDATE settings SET value='200' WHERE key='chunk_size'  AND value IN ('800','1500')"))
            conn.execute(text("UPDATE settings SET value='40'  WHERE key='chunk_overlap' AND value IN ('150','200')"))
            conn.commit()
        except Exception as e:
            import logging as _log
            _log.warning(f"Migration 6 failed: {e}")
        _set_schema_version(conn, 6)

    if ver < 7:
        # Migration 7: remove title chunks from document entries — title embeddings shadow content
        # chunks because short titles score artificially high on short queries.
        doc_title_ids = [r[0] for r in conn.execute(
            text("SELECT c.id FROM chunks c JOIN entries e ON e.id=c.entry_id WHERE e.entry_type='document' AND c.chunk_type='title'")
        ).fetchall()]
        for cid in doc_title_ids:
            try:
                conn.execute(text("DELETE FROM chunks_vec WHERE rowid=:id"), {"id": cid})
            except Exception:
                pass
        conn.execute(
            text("DELETE FROM chunks WHERE chunk_type='title' AND entry_id IN (SELECT id FROM entries WHERE entry_type='document')")
        )
        conn.commit()
        _set_schema_version(conn, 7)


def _get_chunks_vec_dim(conn) -> int | None:
    import re as _re
    row = conn.execute(text("SELECT sql FROM sqlite_master WHERE name='chunks_vec'")).fetchone()
    if not row or not row[0]:
        return None
    m = _re.search(r'float\[(\d+)\]', row[0])
    return int(m.group(1)) if m else None


def _ensure_chunks_vec(conn, dim: int) -> None:
    import logging as _log
    existing = _get_chunks_vec_dim(conn)
    if existing == dim:
        conn.execute(text(f"CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec USING vec0(embedding float[{dim}])"))
    else:
        if existing is not None:
            _log.warning(f"Embedding dimension changed {existing}→{dim}: dropping chunks_vec, all entries will be re-embedded.")
        conn.execute(text("DROP TABLE IF EXISTS chunks_vec"))
        conn.execute(text(f"CREATE VIRTUAL TABLE chunks_vec USING vec0(embedding float[{dim}])"))
    conn.commit()


def init_db(embedding_dim: int) -> None:
    Base.metadata.create_all(bind=engine)
    with engine.connect() as conn:
        _run_migrations(conn)
        _ensure_chunks_vec(conn, embedding_dim)

    db = SessionLocal()
    try:
        # Insert missing defaults
        for key, value in DEFAULT_SETTINGS.items():
            if not db.query(Setting).filter(Setting.key == key).first():
                db.add(Setting(key=key, value=json.dumps(value)))
        db.commit()

        # Apply env var overrides (always win on restart)
        for key, value in SETTINGS_OVERRIDES.items():
            row = db.query(Setting).filter(Setting.key == key).first()
            if row:
                row.value = json.dumps(value)
            else:
                db.add(Setting(key=key, value=json.dumps(value)))
        if SETTINGS_OVERRIDES:
            db.commit()
    finally:
        db.close()


def insert_seed_data() -> None:
    from app.config import DEMO
    from app.import_.chunker import chunk_text

    if not DEMO:
        return

    db = SessionLocal()
    try:
        if db.query(Entry).count() > 0:
            return
        for item in SEED_QA:
            entry = Entry(
                entry_type="qa",
                title=item["question"][:120],
                question=item["question"],
                answer=item["answer"],
                tags=json.dumps(item["tags"]),
            )
            db.add(entry)
            db.flush()
            for tag in item["tags"]:
                db.add(EntryTag(entry_id=entry.id, tag=tag))

            # Question chunk
            db.add(Chunk(
                entry_id=entry.id,
                chunk_index=0,
                chunk_type="question",
                content=item["question"],
            ))

            # Answer chunk(s)
            answer_chunks = chunk_text(item["answer"])
            if not answer_chunks:
                answer_chunks = [item["answer"]]
            for i, ac in enumerate(answer_chunks):
                db.add(Chunk(
                    entry_id=entry.id,
                    chunk_index=i + 1,
                    chunk_type="answer",
                    content=ac,
                ))

            db.flush()
            tags_text = _normalize(" ".join(item["tags"]))
            db.execute(
                text("INSERT INTO entries_fts(rowid, title, question, answer, content, tags) VALUES (:id,:t,:q,:a,'',:tags)"),
                {"id": entry.id, "t": _normalize(entry.title), "q": _normalize(item["question"]), "a": _normalize(item["answer"]), "tags": tags_text},
            )
        db.commit()
    finally:
        db.close()
