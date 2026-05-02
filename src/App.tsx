import { useMemo, useState } from 'react';

type AnalysisResult = {
  score?: number | null;
  peakDb?: number | null;
  rmsDb?: number | null;
  verdicts?: string[] | null;
};

function formatDb(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? `${value.toFixed(1)} dB` : '—';
}

function formatScore(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? `${value.toFixed(0)} / 100` : '—';
}

export default function App() {
  const [result, setResult] = useState<AnalysisResult | null>({
    score: 84,
    peakDb: -1.7,
    rmsDb: -10.4,
    verdicts: ['Balanced loudness', 'Low clipping risk', 'Streaming-safe level']
  });

  const safeVerdicts = useMemo(() => {
    if (!result?.verdicts || !Array.isArray(result.verdicts)) return [];
    return result.verdicts.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
  }, [result]);

  return (
    <main className="app-shell">
      <section className="card compact">
        <header className="card-header">
          <h1>Studio Sense</h1>
          <button
            type="button"
            onClick={() => setResult((prev) => (prev ? null : { score: 82, peakDb: -2.2, rmsDb: -11.1, verdicts: [] }))}
          >
            Toggle result
          </button>
        </header>

        <div className="metrics-grid">
          <div className="metric"><span>Score</span><strong>{formatScore(result?.score)}</strong></div>
          <div className="metric"><span>Peak</span><strong>{formatDb(result?.peakDb)}</strong></div>
          <div className="metric"><span>RMS</span><strong>{formatDb(result?.rmsDb)}</strong></div>
        </div>

        <div className="verdicts">
          <h2>Verdicts</h2>
          {safeVerdicts.length > 0 ? (
            <ul>
              {safeVerdicts.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          ) : (
            <p className="empty">No verdicts available.</p>
          )}
        </div>
      </section>
    </main>
  );
}
