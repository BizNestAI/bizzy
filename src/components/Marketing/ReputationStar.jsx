// src/components/Marketing/ReputationStar.jsx
import React from "react";

let Lottie = null;
try {
  // Lazy require so app still runs if lottie-react isn't installed yet
  // npm i lottie-react
  // or: pnpm add lottie-react / yarn add lottie-react
  Lottie = require("lottie-react").default;
} catch {}

export default function ReputationStar({
  animationJson,   // JSON object (import) or URL string
  size = 140,
  className = "",
  ariaLabel = "Reputation star",
  loop = true,
  autoplay = true,
}) {
  if (Lottie && animationJson) {
    return (
      <div
        className={`relative ${className}`}
        style={{ width: size, height: size }}
        aria-label={ariaLabel}
      >
        <Lottie
          animationData={animationJson}
          loop={loop}
          autoplay={autoplay}
          style={{ width: "100%", height: "100%" }}
        />
      </div>
    );
  }
  // Fallback: a glossy CSS star while Lottie isn't available
  return (
    <div
      className={`relative ${className}`}
      style={{ width: size, height: size }}
      aria-label={ariaLabel}
    >
      <div className="absolute inset-0 rounded-full blur-2xl opacity-30"
           style={{ background: "radial-gradient(50% 50% at 50% 50%, rgba(241,196,15,0.4) 0%, rgba(241,196,15,0) 70%)" }} />
      <div
        className="absolute inset-0"
        style={{
          WebkitMaskImage:
            "url('data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><polygon points=%2250,5 61,38 95,38 67,58 78,91 50,72 22,91 33,58 5,38 39,38%22 fill=%22black%22/></svg>')",
          maskImage:
            "url('data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><polygon points=%2250,5 61,38 95,38 67,58 78,91 50,72 22,91 33,58 5,38 39,38%22 fill=%22black%22/></svg>')",
          background:
            "linear-gradient(180deg, #FFD95A 0%, #F1C40F 60%, #C9A30B 100%)",
          filter: "drop-shadow(0 6px 18px rgba(241,196,15,.35))",
          animation: "pulseStar 3.6s ease-in-out infinite",
        }}
      />
      <style>{`
        @keyframes pulseStar {
          0%, 100% { transform: scale(1); }
          50% { transform: scale(1.03); }
        }
      `}</style>
    </div>
  );
}
