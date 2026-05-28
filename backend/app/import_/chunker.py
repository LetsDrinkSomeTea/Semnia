def chunk_text(text: str, max_chars: int = 1500, overlap_chars: int = 200) -> list[str]:
    paragraphs = [p.strip() for p in text.split("\n\n") if p.strip()]
    chunks: list[str] = []
    current: list[str] = []
    current_len = 0

    for para in paragraphs:
        para_len = len(para)
        if current_len + para_len > max_chars and current:
            chunk = "\n\n".join(current)
            chunks.append(chunk)
            tail = chunk[-overlap_chars:]
            current = [tail] if tail else []
            current_len = len(tail)

        current.append(para)
        current_len += para_len + 2

    if current:
        chunks.append("\n\n".join(current))

    return [c for c in chunks if len(c.strip()) > 50]
