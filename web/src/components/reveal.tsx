'use client';

import { useEffect } from 'react';

/**
 * Reveals `.reveal` elements as they scroll into view.
 *
 * One observer for the whole page rather than a hook per component: the elements are static markup
 * rendered on the server, and giving each of them its own client component would turn an entirely
 * static page into dozens of hydration roots to animate some opacity.
 *
 * Elements are unobserved once shown. A reveal that re-hides when you scroll back up reads as a
 * rendering fault, not as a flourish.
 */
export function RevealOnScroll() {
  useEffect(() => {
    const targets = document.querySelectorAll<HTMLElement>('.reveal:not(.in)');

    // No IntersectionObserver (or reduced motion) — show everything at once. The content is the
    // point; the animation is not.
    const wantsMotion = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!('IntersectionObserver' in window) || !wantsMotion) {
      targets.forEach((el) => el.classList.add('in'));
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          entry.target.classList.add('in');
          observer.unobserve(entry.target);
        }
      },
      // Fires a little before the element reaches the viewport, so the transition finishes about
      // when the reader's eye arrives rather than starting then.
      { rootMargin: '0px 0px -12% 0px', threshold: 0.08 },
    );

    targets.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, []);

  return null;
}
