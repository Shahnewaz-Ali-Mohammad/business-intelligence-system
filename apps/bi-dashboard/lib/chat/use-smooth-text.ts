import { useEffect, useRef, useState } from 'react';

/**
 * Shows streamed text at a steady typing pace. Text arrives in uneven
 * bursts (a sentence at a time); this reveals it a few characters per
 * frame and speeds up when far behind, so it never lags the answer.
 * A rewritten draft restarts from the part both versions share.
 */
export function useSmoothText(target: string, active: boolean) {
  const [shown, setShown] = useState('');
  const targetRef = useRef(target);
  useEffect(() => { targetRef.current = target; }, [target]);

  useEffect(() => {
    if (!active) return;
    let current = '';
    let first = true;
    let frame = 0;
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const tick = () => {
      const goal = targetRef.current;
      let next = current;
      if (!goal.startsWith(next)) {
        let same = 0;
        while (same < next.length && next[same] === goal[same]) same++;
        next = goal.slice(0, same);
      }
      if (next.length < goal.length) {
        const behind = goal.length - next.length;
        next = goal.slice(0, next.length + (reduced ? behind : Math.max(2, Math.ceil(behind / 24))));
      }
      if (first || next !== current) { first = false; current = next; setShown(next); }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [active]);

  if (!active) return target;
  // Never show text the current answer does not contain (a previous
  // answer before the first frame, or the old part of a rewritten draft).
  let same = 0;
  while (same < shown.length && shown[same] === target[same]) same++;
  return shown.slice(0, same);
}
