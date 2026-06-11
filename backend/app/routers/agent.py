import os
import json
import asyncio
from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session
from pydantic import BaseModel

from app.config import SSL_VERIFY
from app.db.session import get_db
from app.db.models import Setting, Entry
from app.search.meilisearch_client import search as ms_search

from agents import Agent, Runner, function_tool, OpenAIChatCompletionsModel
from openai import AsyncOpenAI
import httpx

router = APIRouter(prefix="/api/ai/agent", tags=["agent"])

def _setting(db: Session, key: str, default):
    row = db.query(Setting).filter(Setting.key == key).first()
    return json.loads(row.value) if row else default

class HistoryMessage(BaseModel):
    role: str  # "user" or "assistant"
    content: str

class AgentRequest(BaseModel):
    query: str
    history: list[HistoryMessage] = []

@router.post("")
async def run_agent(req: AgentRequest, db: Session = Depends(get_db)):
    llm_api_key = _setting(db, "llm_api_key", "")
    llm_model = _setting(db, "llm_model", "gpt-4o-mini")
    llm_url = _setting(db, "llm_url", "")

    client_kwargs = {}
    if llm_api_key:
        client_kwargs["api_key"] = llm_api_key
    if llm_url:
        client_kwargs["base_url"] = llm_url

    # Pass verify=SSL_VERIFY so OpenAI calls work behind corporate proxies
    http_client = httpx.AsyncClient(verify=SSL_VERIFY)
    client = AsyncOpenAI(http_client=http_client, **client_kwargs)
    custom_model = OpenAIChatCompletionsModel(model=llm_model, openai_client=client)

    # Side-channel queue: tools push SearchResult objects here,
    # the SSE generator drains it between agent-sdk events.
    side_queue: asyncio.Queue = asyncio.Queue()

    @function_tool
    def search_database(query: str, limit: int = 5, offset: int = 0) -> str:
        """Sucht in der lokalen Wissensdatenbank (Meilisearch) nach Dokumenten und liefert die relevantesten Chunks zurueck."""
        results = ms_search(
            query=query,
            threshold=0.3,
            top_k=limit,
            page=(offset // limit) + 1 if limit > 0 else 1,
            entry_type=None,
            hybrid=True
        )
        if not results:
            return "Keine passenden Dokumente gefunden."

        # Return a text summary for the agent to reason over
        output = []
        for i, res in enumerate(results):
            content = res.get("snippet") or res.get("answer") or ""
            title = res.get("display_title") or "Ohne Titel"
            entry_id = res.get("id", "?")
            output.append(f"--- ERGEBNIS {i+1} ---\nID: {entry_id}\nTitel: {title}\nTextausschnitt: {content[:1000]}")

        return "\n\n".join(output)

    @function_tool
    def mark_source_as_relevant(entry_id: int, reasoning: str, snippet: str) -> str:
        """Markiert ein gefundenes Dokument als relevant und zeigt es dem Nutzer an. Du MUSST ein Snippet (den relevantesten Textausschnitt) und eine Begründung (reasoning) liefern."""
        entry = db.query(Entry).filter(Entry.id == entry_id).first()
        if not entry:
            return f"Fehler: Dokument mit ID {entry_id} nicht gefunden."
            
        tags_list = []
        try:
            if entry.tags:
                tags_list = json.loads(entry.tags)
        except:
            pass

        item = {
            "id": entry.id,
            "entry_type": entry.entry_type,
            "title": entry.title or "",
            "display_title": entry.title or entry.question or "Ohne Titel",
            "question": entry.question,
            "answer": entry.answer or "",
            "snippet": snippet,
            "reasoning": reasoning,
            "highlight_spans": [],
            "score": 1.0,
            "tags": tags_list,
            "call_count": entry.call_count,
            "matched_by": "agent"
        }
        
        side_queue.put_nowait({"type": "results", "items": [item]})
        return f"Erfolg: Dokument {entry_id} wurde dem Nutzer als relevant angezeigt."

    @function_tool
    def read_document(entry_id: int) -> str:
        """Liest den gesamten Text eines Dokuments anhand seiner ID, falls der Textausschnitt der Suche nicht ausreicht."""
        entry = db.query(Entry).filter(Entry.id == entry_id).first()
        if not entry:
            return "Dokument nicht gefunden."
        return f"Titel: {entry.title}\nInhalt: {entry.content or entry.answer}"

    agent_max_turns_setting = db.query(Setting).filter(Setting.key == "agent_max_turns").first()
    agent_max_turns = json.loads(agent_max_turns_setting.value) if agent_max_turns_setting else 10

    @function_tool
    def report_failure(reason: str) -> str:
        """Nutze dieses Tool, wenn du innerhalb des Limits keine relevanten Dokumente gefunden hast."""
        side_queue.put_nowait({"type": "failure", "message": reason})
        return "Fehlermeldung gesendet."

    instruction = (
        "Du bist ein intelligenter Such-Agent für eine interne Wissensdatenbank. "
        "Deine Aufgabe ist es, die relevantesten Dokumente für die Frage des Nutzers zu finden und ihm bereitzustellen. "
        f"ACHTUNG: Du hast maximal {max(1, agent_max_turns - 1)} Iterationen Zeit. Wenn du innerhalb dieses Limits keine Ergebnisse findest, MUSST du `report_failure(reason)` aufrufen! "
        "1. Nutze `search_database(query, limit, offset)` um in der Datenbank zu suchen. Suchergebnisse werden dem Nutzer NICHT automatisch angezeigt. "
        "2. Wenn ein Suchergebnis vielversprechend ist aber der Textausschnitt nicht ausreicht, nutze `read_document(entry_id)` für mehr Kontext. "
        "3. Für JEDES Dokument, das du als relevant erachtest und dem Nutzer zeigen möchtest, MUSST du `mark_source_as_relevant(entry_id, reasoning, snippet)` aufrufen. Wähle als `snippet` den relevantesten Textausschnitt und begründe deine Wahl in `reasoning`. "
        "4. Probiere verschiedene Suchbegriffe und Formulierungen aus, wenn die ersten Ergebnisse nicht ausreichend sind. "
        "5. Wenn du genug Ergebnisse gefunden hast, beende deine Arbeit. "
        "WICHTIG: Gib NIEMALS eine Text-Antwort an den Nutzer zurück. Deine einzige Aufgabe ist es, die Tools aufzurufen. Generiere keinen Text als finale Antwort."
    )

    agent = Agent(
        name="SearchAgent",
        instructions=instruction,
        tools=[search_database, read_document, mark_source_as_relevant, report_failure],
        model=custom_model
    )

    # Build input with history for follow-up questions
    input_messages = []
    for msg in req.history:
        input_messages.append({"role": msg.role, "content": msg.content})
    input_messages.append({"role": "user", "content": req.query})

    # If there's only one message (no history), pass it as a simple string
    agent_input = input_messages if len(input_messages) > 1 else req.query

    async def generate():
        try:
            stream = Runner.run_streamed(agent, input=agent_input, max_turns=agent_max_turns)
            async for event in stream.stream_events():
                # First, drain any side-channel events (SearchResult objects from tools)
                while not side_queue.empty():
                    side_event = side_queue.get_nowait()
                    yield f"data: {json.dumps(side_event)}\n\n"

                event_type = type(event).__name__
                payload = {}

                if hasattr(event, "data") and type(event.data).__name__ == "ResponseTextDeltaEvent":
                    payload = {"type": "message", "text": getattr(event.data, "delta", "")}
                elif hasattr(event, "item"):
                    item = event.item
                    item_type = type(item).__name__
                    if item_type == "ToolCallItem":
                        tool_name = getattr(item, "tool_name", "Unbekannt")
                        
                        args = getattr(item, "arguments", "")
                        if not args and hasattr(item, "raw_item"):
                            args = getattr(item.raw_item, "arguments", "")

                        payload_title = None
                        try:
                            args_dict = json.loads(args) if isinstance(args, str) else args
                            if isinstance(args_dict, dict) and "entry_id" in args_dict:
                                entry_id_val = args_dict["entry_id"]
                                if str(entry_id_val).isdigit():
                                    from app.db.models import Entry
                                    doc_entry = db.query(Entry).filter(Entry.id == int(entry_id_val)).first()
                                    if doc_entry:
                                        payload_title = doc_entry.title or doc_entry.question or f"Dokument {entry_id_val}"
                        except Exception:
                            pass

                        try:
                            if not isinstance(args, str):
                                args = json.dumps(args)
                        except:
                            args = str(args)
                            
                        payload = {"type": "tool_call", "call_id": getattr(item, "call_id", ""), "tool": tool_name, "args": args}
                        if payload_title:
                            payload["title"] = payload_title
                            
                    elif item_type == "ToolCallOutputItem":
                        payload = {"type": "tool_result", "call_id": getattr(item, "call_id", "")}

                if payload:
                    yield f"data: {json.dumps(payload)}\n\n"

            # Final drain of side-channel
            while not side_queue.empty():
                side_event = side_queue.get_nowait()
                yield f"data: {json.dumps(side_event)}\n\n"

            yield f"data: {json.dumps({'type': 'done'})}\n\n"
        except Exception as e:
            if "MaxTurns" in type(e).__name__:
                yield f"data: {json.dumps({'type': 'failure', 'message': 'Agent war nicht in der Lage Dokumente zu finden (Limit erreicht).'})}\n\n"
                yield f"data: {json.dumps({'type': 'done'})}\n\n"
            else:
                yield f"data: {json.dumps({'error': str(e)})}\n\n"

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
