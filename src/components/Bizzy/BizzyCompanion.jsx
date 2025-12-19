// src/components/Bizzy/BizzyCompanion.jsx
import React, { useState } from 'react';
import { useBizzyChatContext } from '../../context/BizzyChatContext';
import heroImage from '../../assets/bizzy-hero.png';

// Chrome/Silver tokens
const CHROME = '#BFBFBF';
const CHROME_SOFT = 'rgba(191,191,191,.50)';

export default function BizzyCompanion({
  accent = CHROME,               // default to chrome
  heroSrc,
  heroAlt = 'Bizzi the Meerkat'
}) {
  const { sendMessage, isLoading } = useBizzyChatContext();
  const [input, setInput] = useState('');
  const imgSrc = heroSrc || heroImage;

  async function onSubmit(e) {
    e.preventDefault();
    if (!input.trim() || isLoading) return;
    await sendMessage(input.trim());
    setInput('');
  }

  return (
    <div className="relative min-h-[72vh] p-4 md:p-8 bg-app text-primary">
      {/* Removed the pink background glow.
          If you want a super subtle chrome vignette, uncomment below: */}
      {/*
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 rounded-3xl"
        style={{
          background: `
            radial-gradient(900px 600px at 10% 0%, rgba(191,191,191,.08), transparent 55%),
            radial-gradient(900px 600px at 90% 100%, rgba(191,191,191,.06), transparent 50%)
          `,
          filter: 'blur(10px)',
          opacity: .9
        }}
      />
      */}

      {/* hero panel (chrome outer glow) */}
      <div
        className="relative rounded-3xl overflow-hidden"
        style={{
          background: 'linear-gradient(180deg, rgba(20,21,22,0.92) 8%, rgba(20,21,22,0.76) 100%)',
          border: `1px solid ${hex(CHROME, .28)}`,
          boxShadow: `0 0 2px ${CHROME_SOFT}`,      // ⬅️ chrome/silver glow
        }}
      >
        {/* header row */}
        <div className="px-5 md:px-8 pt-6 md:pt-8 pb-4 md:pb-6 flex flex-col md:flex-row md:items-center md:justify-between gap-6">
          <div className="flex items-center gap-4 min-w-0">
            {/* hero container with chrome frame glow */}
            <div className="relative w-[140px] md:w-[200px] aspect-[3/4] shrink-0">
              <div
                aria-hidden
                className="absolute inset-0 rounded-2xl"
                style={{
                  boxShadow: `0 0 0 1px ${hex(CHROME, .35)}, 0 0px ${CHROME_SOFT}`
                }}
              />
              <img
                src={imgSrc}
                alt={heroAlt}
                className="absolute inset-0 h-full w-full object-cover rounded-2xl bizzy-float select-none"
                draggable="false"
              />
            </div>

            {/* headline & subcopy */}
            <div className="min-w-0">
              <h1 className="text-xl md:text-3xl leading-tight">
                Meet Bizzi - your go-to companion for business & life.
              </h1>
              <p className="text-secondary text-sm md:text-base mt-1">
                Full companion features coming soon. In the meantime, chat with Bizzi.
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* companion styles */}
      <style>{`
        @keyframes idleFloat {
          0%, 100% { transform: translateY(0) }
          50% { transform: translateY(-3px) }
        }
        .bizzy-float { animation: idleFloat 5.5s ease-in-out infinite; }
      `}</style>
    </div>
  );
}

/* util */
function hex(c, a = 1) {
  const r = parseInt(c.slice(1,3),16);
  const g = parseInt(c.slice(3,5),16);
  const b = parseInt(c.slice(5,7),16);
  return `rgba(${r},${g},${b},${a})`;
}
