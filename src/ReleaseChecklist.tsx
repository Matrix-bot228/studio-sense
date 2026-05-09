import type { ReactNode } from 'react';

type AnalysisResult = {
  lufsEstimate?: number | null;
  peakDb?: number | null;
  rmsDb?: number | null;
  channels?: number | null;
};

type ChecklistStatus = 'pass' | 'warning' | 'fail';

type ChecklistItem = {
  label: string;
  status: ChecklistStatus;
  explanation?: string;
};

type ReleaseChecklistProps = {
  result: AnalysisResult | null;
  autoMarkerCount: number;
  frequencyIssueLabel?: string | null;
};

function itemDisplay(status: ChecklistStatus): { icon: ReactNode; className: string } {
  if (status === 'pass') return { icon: '✅', className: 'pass' };
  if (status === 'warning') return { icon: '⚠️', className: 'warning' };
  return { icon: '❌', className: 'fail' };
}

export default function ReleaseChecklist({ result, autoMarkerCount, frequencyIssueLabel = null }: ReleaseChecklistProps) {
  if (!result) {
    return (
      <section className="release-checklist">
        <h2>Release Checklist</h2>
        <p className="empty">Upload audio to check release readiness.</p>
      </section>
    );
  }

  const loudnessStatus: ChecklistStatus =
    typeof result.lufsEstimate === 'number' && result.lufsEstimate >= -15 && result.lufsEstimate <= -13
      ? 'pass'
      : 'fail';

  const peakStatus: ChecklistStatus =
    typeof result.peakDb === 'number' && result.peakDb <= -1 ? 'pass' : 'fail';

  const rmsStatus: ChecklistStatus =
    typeof result.rmsDb === 'number' && result.rmsDb > -20 ? 'pass' : 'fail';

  const stereoStatus: ChecklistStatus =
    typeof result.channels === 'number' && result.channels > 1 ? 'pass' : 'warning';

  const issueStatus: ChecklistStatus = autoMarkerCount <= 2 ? 'pass' : 'fail';

  const frequencyStatus: ChecklistStatus = frequencyIssueLabel ? 'warning' : 'pass';

  const items: ChecklistItem[] = [
    {
      label: 'Loudness OK',
      status: loudnessStatus,
      explanation: loudnessStatus === 'fail' ? 'Track is too quiet for streaming.' : undefined
    },
    {
      label: 'Peak safe',
      status: peakStatus,
      explanation: peakStatus === 'fail' ? 'Risk of distortion or clipping.' : undefined
    },
    {
      label: 'Signal strength OK',
      status: rmsStatus,
      explanation: rmsStatus === 'fail' ? 'Weak signal, lacks energy.' : undefined
    },
    {
      label: 'Stereo / quality',
      status: stereoStatus,
      explanation: stereoStatus === 'warning' ? 'Mono may sound flat on streaming.' : undefined
    },
    {
      label: 'No major issues',
      status: issueStatus
    },
    {
      label: 'Frequency feel check',
      status: frequencyStatus,
      explanation: frequencyIssueLabel ? `Main issue detected: ${frequencyIssueLabel}. Fix this before final loudness push.` : undefined
    }
  ];

  const hasFail = items.some((item) => item.status === 'fail');
  const hasWarning = items.some((item) => item.status === 'warning');
  const verdict = hasFail
    ? { text: '⚠️ Not ready for release', className: 'fail' }
    : hasWarning
      ? { text: '🟡 Almost ready', className: 'warning' }
      : { text: '✅ Ready for release', className: 'pass' };

  return (
    <section className="release-checklist">
      <h2>Release Checklist</h2>
      <p className={`release-overall ${verdict.className}`}>{verdict.text}</p>
      <ul>
        {items.map((item) => {
          const display = itemDisplay(item.status);
          return (
            <li key={item.label} className={`check-item ${display.className}`}>
              <div className="check-main">
                <span aria-hidden="true">{display.icon}</span>
                <span>{item.label}</span>
              </div>
              {item.explanation ? <p>{item.explanation}</p> : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
