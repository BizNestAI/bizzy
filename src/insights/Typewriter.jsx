// /src/insights/Typewriter.jsx
import React, { useEffect, useRef, useState } from 'react';

/**
 * Typewriter
 * - Animates text character-by-character.
 * - If `autoScroll` is true AND `containerRef` is provided, it softly scrolls to bottom.
 * - The moment `autoScroll` becomes false (e.g., user scrolls), it stops pulling the view.
 *
 * Props:
 *   text: string
 *   speed: ms per step (default 18)
 *   startDelay: ms delay before starting
 *   onDone: () => void
 *   containerRef?: React.RefObject<HTMLElement>  // scroll container (e.g., the chat scroller)
 *   autoScroll?: boolean                          // live flag; true = follow typing, false = hands-off
 *   chunk?: number                                // chars per frame (optional; default time-based)
 */
export default function Typewriter({
  text = '',
  speed = 18,
  startDelay = 0,
  onDone,
  containerRef,
  autoScroll = false,
  chunk,
}) {
  const [out, setOut] = useState('');
  const autoScrollRef = useRef(autoScroll);
  const lastScrollTsRef = useRef(0);

  // keep a live pointer to autoScroll so we react immediately to user unpin
  useEffect(() => { autoScrollRef.current = autoScroll; }, [autoScroll]);

  useEffect(() => {
    // handle reduced motion users
    const prefersReduced =
      typeof window !== 'undefined' &&
      window.matchMedia &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    if (!text) { setOut(''); return; }

    let i = 0;
    let raf;
    let started = false;
    let startAt = 0;

    const step = (ts) => {
      if (!started) {
        started = true;
        startAt = ts + startDelay;
      }
      if (ts < startAt) {
        raf = requestAnimationFrame(step);
        return;
      }

      // compute how many chars to add this frame
      let add = 1;
      if (chunk && chunk > 0) {
        add = chunk;
      } else if (!prefersReduced) {
        // time-based: roughly one char every `speed` ms
        const elapsed = ts - startAt;
        const target = Math.max(1, Math.floor(elapsed / speed));
        add = Math.max(1, target - i);
      } else {
        // reduced motion: jump to full
        add = text.length;
      }

      i = Math.min(text.length, i + add);
      setOut(text.slice(0, i));

      // follow while pinned (but stop instantly when autoScrollRef flips false)
      if (autoScrollRef.current && containerRef?.current) {
        const now = performance.now();
        if (now - lastScrollTsRef.current > 50) {
          lastScrollTsRef.current = now;
          const el = containerRef.current;
          // smooth is okay here; parent will cancel on user intent
          el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
        }
      }

      if (i < text.length) {
        raf = requestAnimationFrame(step);
      } else {
        onDone?.();
      }
    };

    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, speed, startDelay, containerRef]);

  return <span>{out}</span>;
}
