import { useEffect, useState } from 'react';

// Callback ref also observes charts that mount after an asynchronous loading state.
export default function useChartMeasure() {
  const [node, ref] = useState(null);
  const [rect, setRect] = useState({ width: 0, height: 0 });
  useEffect(() => {
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => {
      const next = entry?.contentRect;
      if (next) setRect(previous => previous.width === next.width && previous.height === next.height ? previous : { width: next.width, height: next.height });
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [node]);
  return [ref, rect];
}
