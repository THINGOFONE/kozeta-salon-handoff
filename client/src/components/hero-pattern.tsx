import type { CSSProperties } from "react";

const SCISSORS = [
  { x: 65,  y: 45,  r: -20, s: 1.4,  op: 0.75, dur: 9,  del: 0.0, alt: false, bright: true  },
  { x: 720, y: 38,  r: 30,  s: 1.1,  op: 0.65, dur: 12, del: 1.5, alt: true,  bright: false },
  { x: 380, y: 28,  r: 5,   s: 1.6,  op: 0.60, dur: 11, del: 3.0, alt: false, bright: true  },
  { x: 740, y: 440, r: -40, s: 1.2,  op: 0.72, dur: 8,  del: 0.7, alt: true,  bright: false },
  { x: 30,  y: 360, r: 55,  s: 1.1,  op: 0.62, dur: 13, del: 2.3, alt: false, bright: true  },
  { x: 480, y: 460, r: 10,  s: 1.5,  op: 0.70, dur: 10, del: 4.1, alt: true,  bright: false },
  { x: 175, y: 220, r: -55, s: 0.95, op: 0.55, dur: 15, del: 1.0, alt: false, bright: true  },
  { x: 580, y: 180, r: 20,  s: 1.3,  op: 0.78, dur: 9,  del: 2.8, alt: true,  bright: false },
  { x: 300, y: 350, r: -15, s: 1.45, op: 0.65, dur: 11, del: 5.2, alt: false, bright: true  },
  { x: 95,  y: 145, r: 40,  s: 1.1,  op: 0.60, dur: 14, del: 0.5, alt: true,  bright: false },
  { x: 650, y: 290, r: -25, s: 1.55, op: 0.68, dur: 10, del: 3.5, alt: false, bright: true  },
  { x: 220, y: 430, r: -30, s: 1.35, op: 0.62, dur: 9,  del: 4.7, alt: true,  bright: false },
  { x: 560, y: 390, r: 45,  s: 1.1,  op: 0.58, dur: 11, del: 0.3, alt: false, bright: true  },
  { x: 130, y: 480, r: -10, s: 1.2,  op: 0.64, dur: 13, del: 1.9, alt: true,  bright: false },
  { x: 690, y: 155, r: 70,  s: 1.0,  op: 0.70, dur: 8,  del: 3.1, alt: false, bright: true  },
  { x: 410, y: 310, r: -65, s: 0.9,  op: 0.50, dur: 16, del: 2.6, alt: true,  bright: false },
  { x: 50,  y: 490, r: 20,  s: 1.3,  op: 0.65, dur: 10, del: 5.8, alt: false, bright: true  },
  { x: 780, y: 260, r: -35, s: 1.1,  op: 0.60, dur: 12, del: 0.9, alt: true,  bright: false },
];

const STRANDS = [
  { d: "M 30 70 C 120 30 200 100 290 55",                              op: 0.55, dur: 7,  del: 0.0, rose: false },
  { d: "M 580 35 C 640 80 710 45 775 70",                              op: 0.50, dur: 9,  del: 1.0, rose: true  },
  { d: "M 120 290 C 210 255 290 310 380 278",                           op: 0.58, dur: 8,  del: 2.0, rose: false },
  { d: "M 420 185 C 500 155 570 195 650 170",                           op: 0.48, dur: 11, del: 0.5, rose: true  },
  { d: "M 60 415 C 150 375 230 430 310 400",                            op: 0.55, dur: 7,  del: 3.0, rose: false },
  { d: "M 470 340 C 550 305 630 355 710 328",                           op: 0.52, dur: 10, del: 1.5, rose: true  },
  { d: "M 270 140 C 350 115 430 148 510 130",                           op: 0.48, dur: 9,  del: 2.5, rose: false },
  { d: "M 680 240 C 720 218 758 248 795 232",                           op: 0.54, dur: 8,  del: 0.8, rose: true  },
  { d: "M 80 195 C 155 170 215 210 280 190",                            op: 0.50, dur: 12, del: 4.0, rose: false },
  { d: "M 360 410 C 440 385 520 418 600 400",                           op: 0.48, dur: 7,  del: 1.2, rose: true  },
  { d: "M 10 155 C 80 132 150 162 220 148 C 270 138 330 155 390 140",  op: 0.44, dur: 10, del: 2.0, rose: false },
  { d: "M 520 88 C 590 66 660 95 740 78",                               op: 0.52, dur: 8,  del: 3.5, rose: true  },
  { d: "M 155 370 C 230 345 305 375 380 355",                           op: 0.46, dur: 9,  del: 0.6, rose: false },
  { d: "M 580 460 C 650 438 720 465 790 448",                           op: 0.50, dur: 11, del: 2.8, rose: true  },
  { d: "M 30 260 C 90 238 150 268 210 250",                             op: 0.44, dur: 8,  del: 4.5, rose: false },
  { d: "M 430 490 C 510 468 590 492 670 475",                           op: 0.48, dur: 7,  del: 1.7, rose: true  },
];

const GOLD   = "#e8b84b";
const COPPER = "#d4825a";

export function HeroPattern({ className }: { className?: string }) {
  return (
    <div
      className={`absolute inset-0 pointer-events-none ${className ?? ""}`}
      aria-hidden="true"
    >
      <style>{`
        @keyframes kz-drift {
          0%,100% { transform: translate(0,0) rotate(0deg); }
          25%     { transform: translate(5px,-9px) rotate(2deg); }
          75%     { transform: translate(-4px,5px) rotate(-1.5deg); }
        }
        @keyframes kz-drift-b {
          0%,100% { transform: translate(0,0) rotate(0deg); }
          33%     { transform: translate(-6px,-8px) rotate(-2deg); }
          66%     { transform: translate(4px,4px) rotate(1deg); }
        }
        @keyframes kz-drift-c {
          0%,100% { transform: translate(0,0) rotate(0deg); }
          40%     { transform: translate(6px,-5px) rotate(3deg); }
          80%     { transform: translate(-3px,7px) rotate(-2deg); }
        }
        @keyframes kz-sway {
          0%,100% { transform: translate(0,0); }
          35%     { transform: translate(3px,-7px); }
          70%     { transform: translate(-2px,4px); }
        }
        @keyframes kz-sway-b {
          0%,100% { transform: translate(0,0); }
          45%     { transform: translate(-4px,-5px); }
          80%     { transform: translate(3px,6px); }
        }
        .kz-sc   { animation: kz-drift   ease-in-out infinite; will-change: transform; }
        .kz-sc-b { animation: kz-drift-b ease-in-out infinite; will-change: transform; }
        .kz-sc-c { animation: kz-drift-c ease-in-out infinite; will-change: transform; }
        .kz-st   { animation: kz-sway    ease-in-out infinite; will-change: transform; }
        .kz-st-b { animation: kz-sway-b  ease-in-out infinite; will-change: transform; }
      `}</style>
      <svg
        viewBox="0 0 800 500"
        xmlns="http://www.w3.org/2000/svg"
        className="w-full h-full"
        preserveAspectRatio="xMidYMid slice"
      >
        <defs>
          <linearGradient id="kz-bg" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#17100a" />
            <stop offset="50%" stopColor="#1f1510" />
            <stop offset="100%" stopColor="#2a1a0e" />
          </linearGradient>
          <radialGradient id="kz-glow" cx="50%" cy="50%" r="55%">
            <stop offset="0%"   stopColor="#5c3310" stopOpacity="0.55" />
            <stop offset="60%"  stopColor="#3a2008" stopOpacity="0.25" />
            <stop offset="100%" stopColor="#17100a" stopOpacity="0" />
          </radialGradient>
          <radialGradient id="kz-glow2" cx="20%" cy="80%" r="40%">
            <stop offset="0%"   stopColor="#7a4010" stopOpacity="0.30" />
            <stop offset="100%" stopColor="#17100a" stopOpacity="0" />
          </radialGradient>
        </defs>

        <rect x="0" y="0" width="800" height="500" fill="url(#kz-bg)" />
        <ellipse cx="400" cy="250" rx="380" ry="240" fill="url(#kz-glow)" />
        <ellipse cx="160" cy="400" rx="250" ry="180" fill="url(#kz-glow2)" />

        {STRANDS.map((st, i) => (
          <g key={`st-${i}`}>
            <g
              className={i % 2 === 0 ? "kz-st" : "kz-st-b"}
              style={{
                animationDuration: `${st.dur}s`,
                animationDelay:    `${st.del}s`,
              } as CSSProperties}
            >
              <path
                d={st.d}
                fill="none"
                stroke={st.rose ? COPPER : GOLD}
                strokeWidth="2.8"
                strokeOpacity={st.op}
                strokeLinecap="round"
              />
            </g>
          </g>
        ))}

        {SCISSORS.map((sc, i) => (
          <g
            key={`sc-${i}`}
            transform={`translate(${sc.x},${sc.y}) rotate(${sc.r}) scale(${sc.s})`}
          >
            <g
              className={i % 3 === 0 ? "kz-sc" : i % 3 === 1 ? "kz-sc-b" : "kz-sc-c"}
              style={{
                animationDuration: `${sc.dur}s`,
                animationDelay:    `${sc.del}s`,
              } as CSSProperties}
            >
              <g
                transform="translate(-12,-12)"
                fill="none"
                stroke={sc.bright ? GOLD : COPPER}
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeOpacity={sc.op}
              >
                <circle cx="6" cy="6" r="3.5" />
                <circle cx="6" cy="18" r="3.5" />
                <line x1="20" y1="4" x2="8.12" y2="15.88" />
                <line x1="14.47" y1="14.48" x2="20" y2="20" />
                <line x1="8.12" y1="8.12" x2="12" y2="12" />
              </g>
            </g>
          </g>
        ))}
      </svg>
    </div>
  );
}
