'use client';

import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import HistoryList from './HistoryList';
import SessionDetail from './SessionDetail';

export default function HistoryPageClient() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const params = useSearchParams();
  const router = useRouter();

  useEffect(() => {
    const id = params.get('id');
    if (id) {
      setSelectedId(id);
    }
  }, [params]);

  return (
    <div className="stack">
      <HistoryList
        onSelect={setSelectedId}
        onDeleted={(id) => {
          if (selectedId === id) {
            setSelectedId(null);
            const url = new URL(window.location.href);
            url.searchParams.delete('id');
            router.replace(url.pathname + url.search);
          }
        }}
      />
      <SessionDetail
        sessionId={selectedId}
        onClose={() => {
          setSelectedId(null);
          const url = new URL(window.location.href);
          url.searchParams.delete('id');
          router.replace(url.pathname + url.search);
        }}
      />
    </div>
  );
}

