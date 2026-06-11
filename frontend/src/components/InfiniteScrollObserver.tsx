import { useEffect, useRef } from "react";

interface Props {
  onIntersect: () => void;
  hasMore: boolean;
  loading: boolean;
}

export default function InfiniteScrollObserver({
  onIntersect,
  hasMore,
  loading,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!hasMore || loading) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          onIntersect();
        }
      },
      { rootMargin: "200px" },
    );

    if (ref.current) {
      observer.observe(ref.current);
    }

    return () => observer.disconnect();
  }, [hasMore, loading, onIntersect]);

  if (!hasMore) return null;

  return (
    <div
      ref={ref}
      style={{ textAlign: "center", margin: "2rem 0", opacity: 0.7 }}
    >
      {loading ? (
        <span className="loading-spinner">Lädt...</span>
      ) : (
        "Scrolle für mehr Ergebnisse..."
      )}
    </div>
  );
}
