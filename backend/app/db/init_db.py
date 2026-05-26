import json
from sqlalchemy import text
from app.db.session import Base, engine, SessionLocal
from app.db.models import Entry, EntryTag, Chunk, Setting
from app.config import DEFAULT_SETTINGS, EMBEDDING_DIM


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


def init_db() -> None:
    Base.metadata.create_all(bind=engine)
    with engine.connect() as conn:
        conn.execute(text("""
            CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
                title, question, answer, content,
                tokenize='unicode61 remove_diacritics 2'
            )
        """))
        conn.execute(text(f"""
            CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec USING vec0(
                embedding float[{EMBEDDING_DIM}]
            )
        """))
        conn.commit()

    db = SessionLocal()
    try:
        for key, value in DEFAULT_SETTINGS.items():
            if not db.query(Setting).filter(Setting.key == key).first():
                db.add(Setting(key=key, value=json.dumps(value)))
        db.commit()
    finally:
        db.close()


def insert_seed_data() -> None:
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
            chunk = Chunk(
                entry_id=entry.id,
                chunk_index=0,
                content=f"{item['question']} {item['answer']}",
            )
            db.add(chunk)
            db.flush()
            db.execute(
                text("INSERT INTO entries_fts(rowid, title, question, answer, content) VALUES (:id,:t,:q,:a,'')"),
                {"id": entry.id, "t": entry.title, "q": item["question"], "a": item["answer"]},
            )
        db.commit()
    finally:
        db.close()
