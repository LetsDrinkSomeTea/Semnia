import { useNavigate } from "react-router-dom";
import type { Entry } from "../types";
import EntryTypeBadge from "./EntryTypeBadge";

interface Props {
  entry: Entry;
  onClickTag: (tag: string) => void;
  formatMeta: (e: Entry) => string;
}

export default function BrowseEntryItem({
  entry,
  onClickTag,
  formatMeta,
}: Props) {
  const navigate = useNavigate();

  return (
    <article
      className="result result--browse"
      onClick={() => navigate(`/entries/${entry.id}`)}
      role="button"
    >
      <div>
        <h3 className="q">{entry.display_title}</h3>
        <div className="meta-row">
          <div className="meta-system">
            <EntryTypeBadge type={entry.entry_type} />
          </div>
          {entry.tags.length > 0 && (
            <div className="meta-tags">
              {entry.tags.map((t) => (
                <span
                  className="chip"
                  key={t}
                  role="button"
                  onClick={(ev) => {
                    ev.stopPropagation();
                    onClickTag(t);
                  }}
                >
                  {t}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
      <div className="right-side">
        <span>{formatMeta(entry)}</span>
      </div>
    </article>
  );
}
