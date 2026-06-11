import { useState, useRef, useEffect } from "react";

interface Props {
  tags: string[];
  onChange: (tags: string[]) => void;
  suggestions?: string[];
  suggestedTags?: string[];
}

export default function TagInput({
  tags,
  onChange,
  suggestions = [],
  suggestedTags = [],
}: Props) {
  const [input, setInput] = useState("");
  const [focused, setFocused] = useState(false);
  const [activeIdx, setActiveIdx] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);

  const addTag = (val: string) => {
    const t = val.trim();
    if (!t || tags.includes(t)) {
      setInput("");
      return;
    }
    onChange([...tags, t]);
    setInput("");
    setActiveIdx(-1);
  };

  const removeTag = (tag: string) => onChange(tags.filter((t) => t !== tag));

  const filtered = suggestions.filter(
    (s) => s.toLowerCase().includes(input.toLowerCase()) && !tags.includes(s),
  );

  const dropdownItems: string[] = input
    ? filtered.slice(0, 8)
    : suggestedTags.filter((s) => !tags.includes(s)).slice(0, 8);

  const showDropdown = focused && dropdownItems.length > 0;

  // Ghost text: first suggestion that starts with what the user typed
  const ghostSuggestion = (() => {
    if (!input) return null;
    return (
      filtered.find((s) => s.toLowerCase().startsWith(input.toLowerCase())) ??
      null
    );
  })();
  const ghostSuffix = ghostSuggestion
    ? ghostSuggestion.slice(input.length)
    : "";

  useEffect(() => {
    setActiveIdx(-1);
  }, [input]);

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      if (activeIdx >= 0 && dropdownItems[activeIdx]) {
        addTag(dropdownItems[activeIdx]);
      } else {
        addTag(input);
      }
    } else if (e.key === "Tab" && ghostSuffix) {
      e.preventDefault();
      setInput(ghostSuggestion!);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => Math.min(i + 1, dropdownItems.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => Math.max(i - 1, -1));
    } else if (e.key === "Escape") {
      setFocused(false);
      inputRef.current?.blur();
    } else if (e.key === "Backspace" && !input && tags.length) {
      onChange(tags.slice(0, -1));
    }
  };

  return (
    <div style={{ position: "relative" }}>
      <div className="editor-tags" onClick={() => inputRef.current?.focus()}>
        {tags.map((tag) => (
          <span className="chip" key={tag}>
            {tag}
            <button
              className="x"
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                removeTag(tag);
              }}
            >
              ×
            </button>
          </span>
        ))}
        <div className="tag-input-wrap">
          {ghostSuffix && (
            <div className="tag-input-ghost" aria-hidden>
              <span className="tag-input-ghost-typed">{input}</span>
              <span className="tag-input-ghost-suffix">{ghostSuffix}</span>
            </div>
          )}
          <input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKey}
            onFocus={() => setFocused(true)}
            onBlur={() => {
              setTimeout(() => setFocused(false), 150);
              if (input) addTag(input);
            }}
            placeholder={tags.length ? "" : "Tag eingeben…"}
          />
        </div>
      </div>

      {showDropdown && (
        <div className="tag-dropdown">
          {!input &&
            suggestedTags.filter((s) => !tags.includes(s)).length > 0 && (
              <div className="tag-dropdown-label">Empfohlen</div>
            )}
          {dropdownItems.map((s, i) => (
            <div
              key={s}
              className={`tag-dropdown-item${i === activeIdx ? " active" : ""}`}
              onMouseDown={(e) => {
                e.preventDefault();
                addTag(s);
              }}
              onMouseEnter={() => setActiveIdx(i)}
            >
              {s}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
