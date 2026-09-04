import { useEffect, useRef, useState } from "react";

// Desk pet: a capybara from petdex.dev (MIT, Codex sprite format, 8 columns; v1 9 rows and v2 11 rows
// mean the same). The sheet is served at /pet.webp at half size, 96x104 per cell; swap the file to
// change the pet, delete it to have none.
const SHEET = "/pet.webp";
const CW = 96;
const CH = 104;
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
const W = 70; // displayed width (96 * 0.73)

export default function Pet() {
  const [ok, setOk] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const spr = useRef<HTMLElement>(null);

  useEffect(() => {
    const img = new Image();
    img.onload = () => setOk(true);
    img.src = SHEET;
  }, []);

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
      spr.current.style.backgroundPosition = `-${frame * CW}px -${STATES[state].row * CH}px`;
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
  }, [ok]);

  if (!ok) return null;
  return (
    <div className="pet" ref={box} title="Click me">
      <i ref={spr} style={{ backgroundImage: `url(${SHEET})` }} />
    </div>
  );
}
