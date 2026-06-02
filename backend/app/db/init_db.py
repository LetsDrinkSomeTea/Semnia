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


def init_db(embedding_dim: int) -> None:
    # We no longer use sqlite-vec or fts5. Just standard tables.
    Base.metadata.create_all(bind=engine)
    
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
        
        # Enqueue list for Meilisearch sync
        from app.embeddings.queue import enqueue_entry_chunks
        
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

            db.commit()
            
            # Sync to Meilisearch
            enqueue_entry_chunks(entry.id)
            
    finally:
        db.close()
