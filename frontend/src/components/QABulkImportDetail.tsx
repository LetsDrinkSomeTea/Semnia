import React from "react";
import TagInput from "./TagInput";
import type { QADuplicate } from "../api/client";
import type { ReviewRow } from "../views/Create";

interface Props {
  row: ReviewRow;
  index: number;
  setRowTitle: (i: number, t: string) => void;
  setTags: (i: number, tags: string[]) => void;
  setExpanded: (i: number, exp: boolean) => void;
  setAction: (
    i: number,
    action: ReviewRow["action"],
    replaceId?: number,
  ) => void;
}

export default function QABulkImportDetail({
  row,
  index: i,
  setRowTitle,
  setTags,
  setExpanded,
  setAction,
}: Props) {
  const isConflict = row.duplicates.length > 0;

  return (
    <div className="qa-detail-card">
      <div className="qa-detail-header">
        {isConflict ? "Konflikt lösen" : "Neuer Eintrag"}
      </div>

      <div className={isConflict ? "qa-detail-split" : ""}>
        {/* Left Column: The New Entry */}
        <div className="qa-detail-col">
          {isConflict && <h4>Neuer Import</h4>}
          <input
            className="qa-detail-input"
            placeholder="Titel (optional)"
            value={row.title}
            onChange={(e) => setRowTitle(i, e.target.value)}
          />
          <div className="qa-detail-readonly">
            <div className="qa-detail-readonly-q">{row.question}</div>
            <div className="qa-detail-readonly-a">{row.answer}</div>
          </div>
          <TagInput
            tags={row.tags}
            onChange={(t) => setTags(i, t)}
            suggestedTags={row.suggested_tags}
          />
        </div>

        {/* Right Column: The Existing Entry (if conflict) */}
        {isConflict && (
          <div className="qa-detail-col">
            <h4>Bestehender Datenbank-Eintrag</h4>
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "12px",
                maxHeight: "500px",
                overflowY: "auto",
                paddingRight: "8px",
              }}
            >
              {row.duplicates.map((dupe) => {
                const isSelected =
                  row.action === "replace" && row.replace_id === dupe.id;
                return (
                  <div
                    key={dupe.id}
                    className="qa-detail-readonly"
                    onClick={() => setAction(i, "replace", dupe.id)}
                    style={{
                      cursor: "pointer",
                      margin: 0,
                      borderColor: isSelected
                        ? "var(--base--action)"
                        : "var(--primary--200)",
                      boxShadow: isSelected
                        ? "0 0 0 1px var(--base--action)"
                        : "none",
                      opacity:
                        row.action === "replace" && !isSelected ? 0.5 : 1,
                      transition: "all var(--t)",
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "flex-start",
                        gap: "16px",
                        marginBottom: "8px",
                      }}
                    >
                      <div
                        className="qa-detail-readonly-q"
                        style={{ margin: 0 }}
                      >
                        {dupe.question}
                      </div>
                      <div
                        style={{
                          fontSize: "11px",
                          fontWeight: 600,
                          color: "var(--base--action)",
                          flexShrink: 0,
                        }}
                      >
                        {Math.round(dupe.score * 100)}% Match
                      </div>
                    </div>
                    <div className="qa-detail-readonly-a">{dupe.answer}</div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* Action Bar */}
      <div className="qa-detail-actions">
        <div className="qa-dupe-action-row">
          <label className={row.action === "import" ? "active" : ""}>
            <input
              type="radio"
              name={`action-${i}`}
              value="import"
              checked={row.action === "import"}
              onChange={() => setAction(i, "import")}
            />
            {isConflict
              ? "Trotzdem als neu importieren"
              : "Als neu importieren"}
          </label>
          <label className={row.action === "skip" ? "active" : ""}>
            <input
              type="radio"
              name={`action-${i}`}
              value="skip"
              checked={row.action === "skip"}
              onChange={() => setAction(i, "skip")}
            />
            Überspringen
          </label>
          {isConflict && (
            <label className={row.action === "replace" ? "active" : ""}>
              <input
                type="radio"
                name={`action-${i}`}
                value="replace"
                checked={row.action === "replace"}
                onChange={() =>
                  setAction(
                    i,
                    "replace",
                    row.replace_id || row.duplicates[0]?.id,
                  )
                }
              />
              Ausgewählten überschreiben
            </label>
          )}
        </div>
      </div>
    </div>
  );
}
