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
                title, question, answer, content,
                tokenize='trigram'
            )
        """))
        conn.commit()


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
            db.execute(
                text("INSERT INTO entries_fts(rowid, title, question, answer, content) VALUES (:id,:t,:q,:a,'')"),
                {"id": entry.id, "t": _normalize(entry.title), "q": _normalize(item["question"]), "a": _normalize(item["answer"])},
            )
        db.commit()
    finally:
        db.close()
