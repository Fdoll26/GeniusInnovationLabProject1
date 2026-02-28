'use client';

import { useEffect, useMemo, useState } from 'react';

type LoadingBarProps = {
  progress?: number;
};

const ROWS = 3;
const COLS = 32;

function clampProgress(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.trunc(value)));
}

export default function LoadingBar({ progress }: LoadingBarProps) {
  const [animatedProgress, setAnimatedProgress] = useState(6);
  const determinate = typeof progress === 'number';
  const normalized = determinate ? clampProgress(progress) : animatedProgress;
  const filledCols = Math.floor((normalized / 100) * COLS);

  useEffect(() => {
    if (determinate) return;

    const id = setInterval(() => {
      setAnimatedProgress((prev) => (prev >= 94 ? 6 : prev + 3));
    }, 120);

    return () => clearInterval(id);
  }, [determinate]);

  const columns = useMemo(() => Array.from({ length: COLS }), []);

  return (
    <div className="loading-grid-bar" aria-hidden>
      {columns.map((_, col) => {
        const isFilled = col < filledCols;
        const isPulsing = col >= filledCols && col < filledCols + 3;

        return (
          <div key={col} className="loading-grid-bar__column">
            {Array.from({ length: ROWS }).map((__, row) => {
              const pulseDelay = isPulsing
                ? `${(col - filledCols) * 140 + row * 90}ms`
                : '0ms';

              return (
                <div
                  key={row}
                  className={`loading-grid-bar__cell ${isPulsing ? 'is-pulsing' : ''}`}
                  style={{
                    backgroundColor: isFilled
                      ? 'var(--brand)'
                      : isPulsing
                        ? 'color-mix(in srgb, var(--brand) 45%, transparent)'
                        : 'color-mix(in srgb, var(--border-strong) 78%, var(--card))',
                    animationDelay: pulseDelay
                  }}
                />
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
