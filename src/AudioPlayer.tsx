import { useEffect, useMemo, useRef, useState } from 'react';

type AudioPlayerProps = {
  audioUrl: string | null;
  startSec: number | null;
  endSec: number | null;
  timelineMarkers?: Array<{ id: string; timeSec: number; label: string; color: 'red' | 'yellow' | 'blue' | 'purple'; estimated?: boolean }>;
  seekToSec?: number | null;
  onSeekHandled?: () => void;
  onTimeChange: (time: number) => void;
  onDurationChange: (duration: number) => void;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function formatClock(seconds: number | null | undefined): string {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return '00:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export default function AudioPlayer({ audioUrl, startSec, endSec, timelineMarkers = [], seekToSec = null, onSeekHandled, onTimeChange, onDurationChange }: AudioPlayerProps) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [loopSection, setLoopSection] = useState(false);

  const hasSelection = startSec !== null && endSec !== null && endSec > startSec;

  useEffect(() => {
    if (!audioUrl) {
      setCurrentTime(0);
      setDuration(0);
      setIsPlaying(false);
      setLoopSection(false);
      onTimeChange(0);
      onDurationChange(0);
    }
  }, [audioUrl, onDurationChange, onTimeChange]);

  useEffect(() => () => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
  }, []);

  useEffect(() => {
    if (!hasSelection) setLoopSection(false);
  }, [hasSelection]);

  const selectionStyle = useMemo(() => {
    if (!hasSelection || duration <= 0) return null;
    const left = clamp(((startSec ?? 0) / duration) * 100, 0, 100);
    const right = clamp(((endSec ?? 0) / duration) * 100, 0, 100);
    return { left: `${left}%`, width: `${Math.max(right - left, 0)}%` };
  }, [duration, endSec, hasSelection, startSec]);
  const markerStyles = useMemo(
    () => timelineMarkers.map((marker) => {
      const left = duration > 0 ? clamp((marker.timeSec / duration) * 100, 0, 100) : 0;
      return { ...marker, left };
    }),
    [duration, timelineMarkers]
  );

  useEffect(() => {
    if (typeof seekToSec === 'number' && Number.isFinite(seekToSec)) {
      seek(seekToSec);
      onSeekHandled?.();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seekToSec]);

  function syncCurrentTime(nextTime: number): void {
    setCurrentTime(nextTime);
    onTimeChange(nextTime);
  }

  function tick(): void {
    const audio = audioRef.current;
    if (!audio) return;
    const t = audio.currentTime || 0;
    if (loopSection && hasSelection && startSec !== null && endSec !== null && t >= endSec) {
      audio.currentTime = startSec;
      syncCurrentTime(startSec);
    } else {
      syncCurrentTime(t);
    }

    if (!audio.paused) rafRef.current = requestAnimationFrame(tick);
  }

  function togglePlay(): void {
    const audio = audioRef.current;
    if (!audio || !audioUrl) return;
    if (audio.paused) {
      void audio.play();
      rafRef.current = requestAnimationFrame(tick);
    } else {
      audio.pause();
    }
  }

  function seek(nextTime: number): void {
    const audio = audioRef.current;
    if (!audio) return;
    const safeTime = clamp(nextTime, 0, Math.max(duration, 0));
    audio.currentTime = safeTime;
    syncCurrentTime(safeTime);
  }

  return <section className="guidance"><h2>Audio Player</h2>
    <audio
      ref={audioRef}
      src={audioUrl ?? undefined}
      onLoadedMetadata={(e) => {
        const nextDuration = e.currentTarget.duration || 0;
        setDuration(nextDuration);
        onDurationChange(nextDuration);
      }}
      onTimeUpdate={(e) => syncCurrentTime(e.currentTarget.currentTime || 0)}
      onPlay={() => setIsPlaying(true)}
      onPause={() => {
        setIsPlaying(false);
        if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      }}
      onEnded={() => {
        setIsPlaying(false);
        if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      }}
    />
    <div className="workflow-row">
      <button className="upload-btn" type="button" onClick={togglePlay} disabled={!audioUrl}>{isPlaying ? 'Pause' : 'Play'}</button>
      <span>{formatClock(currentTime)} / {formatClock(duration)}</span>
    </div>

    <div className="scrubber-wrap">
      {selectionStyle ? <div className="selection-highlight" style={selectionStyle} /> : null}
      {markerStyles.map((marker) => <button
        key={marker.id}
        type="button"
        className={`timeline-marker ${marker.color}`}
        style={{ left: `${marker.left}%` }}
        title={`${marker.label} • ${formatClock(marker.timeSec)}${marker.estimated ? ' • estimated marker based on whole-track analysis' : ''}`}
        onClick={() => seek(marker.timeSec)}
      />)}
      <input
        className="scrubber"
        type="range"
        min={0}
        max={Math.max(duration, 0.01)}
        step={0.01}
        value={Math.min(currentTime, duration)}
        onChange={(e) => seek(Number(e.target.value))}
        disabled={!audioUrl}
      />
    </div>

    <div className="workflow-row">
      <span className="empty">{hasSelection ? `Selected: ${formatClock(startSec)} - ${formatClock(endSec)}` : 'No section selected.'}</span>
      <button className="upload-btn" type="button" disabled={!hasSelection || !audioUrl} onClick={() => setLoopSection((v) => !v)}>{loopSection ? 'Looping on' : 'Loop section'}</button>
    </div>
  </section>;
}
