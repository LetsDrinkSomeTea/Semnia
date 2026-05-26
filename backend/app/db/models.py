from sqlalchemy import Column, Integer, String, DateTime, ForeignKey, func
from app.db.session import Base


class Entry(Base):
    __tablename__ = "entries"

    id = Column(Integer, primary_key=True, index=True)
    entry_type = Column(String, nullable=False)  # 'qa' | 'document'
    title = Column(String, nullable=False)
    question = Column(String, nullable=True)
    answer = Column(String, nullable=True)
    content = Column(String, nullable=True)      # full document text
    source_filename = Column(String, nullable=True)
    tags = Column(String, default="[]")           # JSON: ["tag1","tag2"]
    created_at = Column(DateTime, default=func.now())
    updated_at = Column(DateTime, default=func.now(), onupdate=func.now())
    call_count = Column(Integer, default=0)


class EntryTag(Base):
    __tablename__ = "entry_tags"

    entry_id = Column(Integer, ForeignKey("entries.id", ondelete="CASCADE"), primary_key=True)
    tag = Column(String, primary_key=True)


class Chunk(Base):
    """Internal search index — one chunk per Q&A, N chunks per document."""
    __tablename__ = "chunks"

    id = Column(Integer, primary_key=True, index=True)
    entry_id = Column(Integer, ForeignKey("entries.id", ondelete="CASCADE"), nullable=False)
    chunk_index = Column(Integer, nullable=False, default=0)
    content = Column(String, nullable=False)


class Setting(Base):
    __tablename__ = "settings"

    key = Column(String, primary_key=True)
    value = Column(String, nullable=False)
