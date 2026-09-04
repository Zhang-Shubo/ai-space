import { useEffect, useRef, useState } from "react";

// Desk pet: a sprite sheet in the Codex format (8 columns; v1 9 rows and v2 11 rows mean the same,
// cells 12:13). The bundled default is a capybara from petdex.dev at /pet.webp, stored at half size;
// any other sheet from petdex.dev can be shown by name (see petdex.ts). Cell size comes from the image,
// so a half-size and a full-size sheet both draw at the same 70 px on screen. The sheet is an <img>
// moved inside a clipping box rather than a CSS background: an image needs no CORS, and it can be
// loaded without a Referer, which petdex's hotlink protection insists on.
export const DEFAULT_SHEET = "/pet.webp";
const COLS = 8;
const STATES = {
  idle: { row: 0, frames: 6, ms: 1100 },
  right: { row: 1, frames: 8, ms: 1060 },
  left: { row: 2, frames: 8, ms: 1060 },
  wave: { row: 3, frames: 4, ms: 700 },
  jump: { row: 4, frames: 5, ms: 840 },
  wait: { row: 6, frames: 6, ms: 1010 },
} as const;
type State = keyof typeof STATES;
const SPEED = 55; // px/s
const W = 70; // displayed width

type Cell = { w: number; h: number };

/**
 * `sheet` is the sprite sheet URL; when it fails to load the bundled default is shown instead and
 * `onError` fires once so the owner can re-resolve or forget the choice.
 */
export default function Pet({ sheet = DEFAULT_SHEET, onError }: { sheet?: string; onError?: (sheet: string) => void }) {
  const [loaded, setLoaded] = useState<{ src: string; cell: Cell } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const spr = useRef<HTMLImageElement>(null);
  const fail = useRef(onError);
  fail.current = onError;

  // Load the sheet off-screen to learn its cell size; the previous pet stays until the new one is ready.
  useEffect(() => {
    let live = true;
    const load = (src: string, fallback: boolean) => {
      const img = new Image();
      img.referrerPolicy = "no-referrer";
      img.onload = () => {
        if (!live) return;
        const w = img.naturalWidth / COLS;
        const rows = Math.max(1, Math.round(img.naturalHeight / ((w * 13) / 12)));
        setLoaded({ src, cell: { w, h: img.naturalHeight / rows } });
      };
      img.onerror = () => {
        if (!live) return;
        if (fallback) return setLoaded(null);
        fail.current?.(src);
        load(DEFAULT_SHEET, true);
      };
      img.src = src;
    };
    load(sheet, sheet === DEFAULT_SHEET);
    return () => {
      live = false;
    };
  }, [sheet]);

  const ok = loaded !== null;
  const CW = loaded?.cell.w ?? 1;
  const CH = loaded?.cell.h ?? 1;
  useEffect(() => {
    if (!ok || !box.current || !spr.current) return;
    let x = Math.random() * Math.max(0, innerWidth - W);
    let state: State = "idle";
    let frame = 0;
    let target = x;
    let oneShot: (() => void) | null = null;
    let frameTimer: ReturnType<typeof setInterval> | undefined;
    let behaveTimer: ReturnType<typeof setTimeout> | undefined;

    const draw = () => {
      if (!spr.current || !box.current) return;
      spr.current.style.transform = `translate(${-frame * CW}px, ${-STATES[state].row * CH}px)`;
      box.current.style.transform = `translate3d(${x}px,0,0)`;
    };
    const setState = (s: State) => {
      state = s;
      frame = 0;
      clearInterval(frameTimer);
      frameTimer = setInterval(() => {
        frame += 1;
        if (frame >= STATES[state].frames) {
          frame = 0;
          if (oneShot) {
            const done = oneShot;
            oneShot = null;
            done();
          }
        }
        draw();
      }, STATES[s].ms / STATES[s].frames);
      draw();
    };
    // Random behaviour: walk somewhere, idle, wait or wave.
    const behave = () => {
      clearTimeout(behaveTimer);
      const r = Math.random();
      if (r < 0.45) {
        target = Math.random() * Math.max(0, innerWidth - W);
        setState(target > x ? "right" : "left");
      } else {
        setState(r < 0.75 ? "idle" : r < 0.9 ? "wait" : "wave");
        behaveTimer = setTimeout(behave, 1800 + Math.random() * 3500);
      }
    };
    const mover = setInterval(() => {
      if (state !== "left" && state !== "right") return;
      const step = (SPEED / 25) * (state === "right" ? 1 : -1);
      x += step;
      if ((state === "right" && x >= target) || (state === "left" && x <= target)) {
        x = target;
        behave();
      }
      draw();
    }, 40);
    // Click: jump.
    const el = box.current;
    const jump = () => {
      if (state !== "jump") {
        oneShot = behave;
        setState("jump");
      }
    };
    el.addEventListener("click", jump);

    behave();
    return () => {
      clearInterval(frameTimer);
      clearInterval(mover);
      clearTimeout(behaveTimer);
      el.removeEventListener("click", jump);
    };
  }, [ok, CW, CH]);

  if (!loaded) return null;
  const scale = W / CW;
  return (
    <div className="pet" ref={box} title="Click me" style={{ width: W, height: Math.round(CH * scale) }}>
      <i style={{ width: CW, height: CH, transform: `scale(${scale})` }}>
        <img ref={spr} src={loaded.src} alt="" referrerPolicy="no-referrer" draggable={false} />
      </i>
    </div>
  );
}
