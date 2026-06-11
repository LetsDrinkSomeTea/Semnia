import EntryTypeBadge from "./EntryTypeBadge";

interface Props {
  title: string;
  entry_type: "qa" | "document";
  onClick: () => void;
}

export default function EntryRow({ title, entry_type, onClick }: Props) {
  return (
    <div className="entry-row" onClick={onClick} role="button">
      <EntryTypeBadge type={entry_type} />
      <span className="entry-row-title">{title}</span>
    </div>
  );
}
