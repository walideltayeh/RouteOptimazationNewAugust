import { useState, useEffect, useRef, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { ArrowRight, Map, Route, FileSpreadsheet } from 'lucide-react';
import BrandMark from '@/components/brand-mark';
import { motion, AnimatePresence } from 'framer-motion';

interface LandingPageProps {
  onAdminLogin: () => void;
}

interface Dot {
  x: number;
  y: number;
  originX: number;
  originY: number;
  targetX: number;
  targetY: number;
  vx: number;
  vy: number;
  radius: number;
  cluster: number;
  phase: number;
  born: number;
}

interface RouteParticle {
  edgeIdx: number;
  progress: number;
  speed: number;
  trail: { x: number; y: number; alpha: number }[];
}

const enum Phase {
  SCATTER = 0,
  CLUSTERING = 1,
  ROUTING = 2,
  FLOWING = 3,
  DISSOLVE = 4,
}

const PHASE_DURATIONS = [2.5, 3.0, 2.5, 5.0, 2.0];

// Brand red, ink and slate: territories read apart without leaving the brand.
const CLUSTER_COLORS = [
  [200, 30, 45],
  [15, 23, 42],
  [71, 85, 105],
  [225, 72, 85],
  [148, 27, 42],
  [100, 116, 139],
];

function easeInOutCubic(t: number) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function easeOutExpo(t: number) {
  return t === 1 ? 1 : 1 - Math.pow(2, -10 * t);
}

function OptimizationCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stateRef = useRef({
    dots: [] as Dot[],
    edges: [] as [number, number][],
    routeParticles: [] as RouteParticle[],
    phase: Phase.SCATTER as number,
    phaseTime: 0,
    totalTime: 0,
    edgeDrawProgress: 0,
    mouseX: -9999,
    mouseY: -9999,
    width: 0,
    height: 0,
  });
  const animRef = useRef(0);

  const buildClusters = useCallback((w: number, h: number) => {
    const s = stateRef.current;
    const numClusters = 6;
    const dotsPerCluster = 10;
    const totalDots = numClusters * dotsPerCluster;

    const clusterCenters = [
      { x: w * 0.12, y: h * 0.28 },
      { x: w * 0.30, y: h * 0.68 },
      { x: w * 0.48, y: h * 0.22 },
      { x: w * 0.65, y: h * 0.58 },
      { x: w * 0.82, y: h * 0.32 },
      { x: w * 0.75, y: h * 0.78 },
    ];

    const dots: Dot[] = [];
    for (let i = 0; i < totalDots; i++) {
      const cluster = Math.floor(i / dotsPerCluster);
      const center = clusterCenters[cluster];
      const spread = Math.min(w, h) * 0.06;
      const angle = Math.random() * Math.PI * 2;
      const dist = Math.random() * spread;

      dots.push({
        x: Math.random() * w,
        y: Math.random() * h,
        originX: Math.random() * w,
        originY: Math.random() * h,
        targetX: center.x + Math.cos(angle) * dist,
        targetY: center.y + Math.sin(angle) * dist,
        vx: (Math.random() - 0.5) * 2,
        vy: (Math.random() - 0.5) * 2,
        radius: 2.5 + Math.random() * 2,
        cluster,
        phase: Math.random() * Math.PI * 2,
        born: Math.random() * 1.5,
      });
    }
    s.dots = dots;

    const edges: [number, number][] = [];
    for (let c = 0; c < numClusters; c++) {
      const ci = dots
        .map((_, i) => i)
        .filter((i) => dots[i].cluster === c);
      if (ci.length < 2) continue;

      const visited = new Set<number>();
      let cur = ci[0];
      visited.add(cur);
      while (visited.size < ci.length) {
        let best = -1;
        let bestD = Infinity;
        for (const j of ci) {
          if (visited.has(j)) continue;
          const dx = dots[j].targetX - dots[cur].targetX;
          const dy = dots[j].targetY - dots[cur].targetY;
          const d = dx * dx + dy * dy;
          if (d < bestD) { bestD = d; best = j; }
        }
        if (best >= 0) {
          edges.push([cur, best]);
          visited.add(best);
          cur = best;
        }
      }
      edges.push([cur, ci[0]]);
    }

    for (let c = 0; c < numClusters - 1; c++) {
      const nodesA = dots.map((_, i) => i).filter((i) => dots[i].cluster === c);
      const nodesB = dots.map((_, i) => i).filter((i) => dots[i].cluster === c + 1);
      let bestA = nodesA[0], bestB = nodesB[0], bestD = Infinity;
      for (const a of nodesA) {
        for (const b of nodesB) {
          const dx = dots[a].targetX - dots[b].targetX;
          const dy = dots[a].targetY - dots[b].targetY;
          const d = dx * dx + dy * dy;
          if (d < bestD) { bestD = d; bestA = a; bestB = b; }
        }
      }
      edges.push([bestA, bestB]);
    }

    s.edges = edges;

    const rp: RouteParticle[] = [];
    for (let i = 0; i < 40; i++) {
      rp.push({
        edgeIdx: Math.floor(Math.random() * edges.length),
        progress: Math.random(),
        speed: 0.006 + Math.random() * 0.01,
        trail: [],
      });
    }
    s.routeParticles = rp;

    s.phase = Phase.SCATTER;
    s.phaseTime = 0;
    s.edgeDrawProgress = 0;
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;
    if (!ctx) return;

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      stateRef.current.width = rect.width;
      stateRef.current.height = rect.height;
      buildClusters(rect.width, rect.height);
    };
    resize();
    window.addEventListener('resize', resize);

    const onMouse = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      stateRef.current.mouseX = e.clientX - rect.left;
      stateRef.current.mouseY = e.clientY - rect.top;
    };
    window.addEventListener('mousemove', onMouse);

    let lastTime = performance.now();

    const loop = (now: number) => {
      const dt = Math.min((now - lastTime) / 1000, 0.05);
      lastTime = now;

      const s = stateRef.current;
      const w = s.width;
      const h = s.height;
      s.totalTime += dt;
      s.phaseTime += dt;

      const phaseDur = PHASE_DURATIONS[s.phase];
      if (s.phaseTime >= phaseDur) {
        s.phaseTime = 0;
        s.phase = (s.phase + 1) % 5;
        if (s.phase === Phase.SCATTER) {
          for (const dot of s.dots) {
            dot.originX = dot.x;
            dot.originY = dot.y;
            const newScatterX = Math.random() * w;
            const newScatterY = Math.random() * h;
            dot.x = dot.originX;
            dot.y = dot.originY;
            dot.originX = dot.x;
            dot.originY = dot.y;
            dot.vx = (newScatterX - dot.x) / 60;
            dot.vy = (newScatterY - dot.y) / 60;
          }
          s.edgeDrawProgress = 0;
        }
        if (s.phase === Phase.CLUSTERING) {
          for (const dot of s.dots) {
            dot.originX = dot.x;
            dot.originY = dot.y;
          }
        }
      }

      const phaseT = s.phaseTime / phaseDur;

      ctx.clearRect(0, 0, w, h);

      const { dots, edges, routeParticles, mouseX, mouseY } = s;

      if (s.phase === Phase.SCATTER) {
        for (const dot of dots) {
          dot.x += dot.vx;
          dot.y += dot.vy;
          dot.vx *= 0.97;
          dot.vy *= 0.97;
          dot.vx += (Math.random() - 0.5) * 0.1;
          dot.vy += (Math.random() - 0.5) * 0.1;
          if (dot.x < 0) dot.x = 0;
          if (dot.x > w) dot.x = w;
          if (dot.y < 0) dot.y = 0;
          if (dot.y > h) dot.y = h;
        }
      }

      if (s.phase === Phase.CLUSTERING) {
        const ease = easeInOutCubic(phaseT);
        for (const dot of dots) {
          dot.x = dot.originX + (dot.targetX - dot.originX) * ease;
          dot.y = dot.originY + (dot.targetY - dot.originY) * ease;
        }
      }

      if (s.phase === Phase.ROUTING || s.phase === Phase.FLOWING) {
        for (const dot of dots) {
          const breathe = Math.sin(s.totalTime * 1.2 + dot.phase) * 0.8;
          dot.x = dot.targetX + breathe;
          dot.y = dot.targetY + breathe;
        }
      }

      if (s.phase === Phase.DISSOLVE) {
        const dissolveT = easeOutExpo(phaseT);
        for (const dot of dots) {
          const angle = dot.phase + s.totalTime * 0.5;
          const dist = dissolveT * Math.min(w, h) * 0.4;
          dot.x = dot.targetX + Math.cos(angle) * dist;
          dot.y = dot.targetY + Math.sin(angle) * dist;
        }
      }

      for (const dot of dots) {
        const dx = mouseX - dot.x;
        const dy = mouseY - dot.y;
        const md = Math.sqrt(dx * dx + dy * dy);
        if (md < 150 && md > 0) {
          const push = (150 - md) / 150 * 8;
          dot.x -= (dx / md) * push * dt * 10;
          dot.y -= (dy / md) * push * dt * 10;
        }
      }

      if (s.phase === Phase.ROUTING) {
        s.edgeDrawProgress = easeInOutCubic(phaseT);
      }

      if (s.phase >= Phase.ROUTING && s.phase <= Phase.FLOWING) {
        const drawFrac = s.phase === Phase.ROUTING ? s.edgeDrawProgress : 1;
        const edgesToDraw = Math.floor(edges.length * drawFrac);

        for (let e = 0; e < edgesToDraw; e++) {
          const [a, b] = edges[e];
          const dA = dots[a];
          const dB = dots[b];
          if (!dA || !dB) continue;

          const isCross = dA.cluster !== dB.cluster;
          const col = CLUSTER_COLORS[dA.cluster % CLUSTER_COLORS.length];

          let edgeFrac = 1;
          if (e === edgesToDraw - 1 && s.phase === Phase.ROUTING) {
            const frac = edges.length * drawFrac;
            edgeFrac = frac - Math.floor(frac);
          }

          const mx = dA.x + (dB.x - dA.x) * edgeFrac;
          const my = dA.y + (dB.y - dA.y) * edgeFrac;

          ctx.beginPath();
          ctx.moveTo(dA.x, dA.y);
          ctx.lineTo(mx, my);
          ctx.strokeStyle = isCross
            ? `rgba(${col[0]}, ${col[1]}, ${col[2]}, 0.08)`
            : `rgba(${col[0]}, ${col[1]}, ${col[2]}, 0.18)`;
          ctx.lineWidth = isCross ? 0.8 : 1.2;
          ctx.stroke();
        }
      }

      if (s.phase === Phase.DISSOLVE) {
        const fadeOut = 1 - easeOutExpo(phaseT);
        for (const [a, b] of edges) {
          const dA = dots[a];
          const dB = dots[b];
          if (!dA || !dB) continue;
          const col = CLUSTER_COLORS[dA.cluster % CLUSTER_COLORS.length];
          ctx.beginPath();
          ctx.moveTo(dA.x, dA.y);
          ctx.lineTo(dB.x, dB.y);
          ctx.strokeStyle = `rgba(${col[0]}, ${col[1]}, ${col[2]}, ${0.18 * fadeOut})`;
          ctx.lineWidth = 1.2;
          ctx.stroke();
        }
      }

      if (s.phase === Phase.FLOWING) {
        for (const rp of routeParticles) {
          rp.progress += rp.speed;
          if (rp.progress >= 1) {
            rp.progress = 0;
            rp.edgeIdx = Math.floor(Math.random() * edges.length);
            rp.trail = [];
          }

          const [a, b] = edges[rp.edgeIdx];
          const dA = dots[a];
          const dB = dots[b];
          if (!dA || !dB) continue;

          const px = dA.x + (dB.x - dA.x) * rp.progress;
          const py = dA.y + (dB.y - dA.y) * rp.progress;

          rp.trail.push({ x: px, y: py, alpha: 1 });
          if (rp.trail.length > 12) rp.trail.shift();

          const col = CLUSTER_COLORS[dA.cluster % CLUSTER_COLORS.length];

          for (let t = 0; t < rp.trail.length; t++) {
            const pt = rp.trail[t];
            pt.alpha *= 0.85;
            const sz = 1 + (t / rp.trail.length) * 2;
            ctx.beginPath();
            ctx.arc(pt.x, pt.y, sz, 0, Math.PI * 2);
            ctx.fillStyle = `rgba(${col[0]}, ${col[1]}, ${col[2]}, ${pt.alpha * 0.6})`;
            ctx.fill();
          }

          const glow = ctx.createRadialGradient(px, py, 0, px, py, 8);
          glow.addColorStop(0, `rgba(${col[0]}, ${col[1]}, ${col[2]}, 0.4)`);
          glow.addColorStop(1, `rgba(${col[0]}, ${col[1]}, ${col[2]}, 0)`);
          ctx.beginPath();
          ctx.arc(px, py, 8, 0, Math.PI * 2);
          ctx.fillStyle = glow;
          ctx.fill();
        }
      }

      let dotGlobalAlpha = 1;
      if (s.phase === Phase.SCATTER) {
        dotGlobalAlpha = Math.min(1, phaseT * 3);
      }
      if (s.phase === Phase.DISSOLVE) {
        dotGlobalAlpha = 1 - easeOutExpo(phaseT);
      }

      for (const dot of dots) {
        if (s.phase === Phase.SCATTER && s.totalTime < dot.born) continue;

        const col = CLUSTER_COLORS[dot.cluster % CLUSTER_COLORS.length];
        const pulse = Math.sin(s.totalTime * 2 + dot.phase) * 0.25 + 0.75;
        const r = dot.radius * pulse;

        const clusterAlpha = (s.phase >= Phase.CLUSTERING) ? 1 : 0.5;
        const alpha = clusterAlpha * dotGlobalAlpha;

        const glow = ctx.createRadialGradient(dot.x, dot.y, 0, dot.x, dot.y, r * 5);
        glow.addColorStop(0, `rgba(${col[0]}, ${col[1]}, ${col[2]}, ${alpha * 0.12})`);
        glow.addColorStop(1, `rgba(${col[0]}, ${col[1]}, ${col[2]}, 0)`);
        ctx.beginPath();
        ctx.arc(dot.x, dot.y, r * 5, 0, Math.PI * 2);
        ctx.fillStyle = glow;
        ctx.fill();

        ctx.beginPath();
        ctx.arc(dot.x, dot.y, r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${col[0]}, ${col[1]}, ${col[2]}, ${alpha * 0.85})`;
        ctx.fill();

        ctx.beginPath();
        ctx.arc(dot.x, dot.y, r * 0.4, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255, 255, 255, ${alpha * 0.6})`;
        ctx.fill();
      }

      if (s.phase >= Phase.CLUSTERING && s.phase <= Phase.FLOWING) {
        const ringAlpha = s.phase === Phase.CLUSTERING ? easeInOutCubic(phaseT) * 0.06 : 0.06;
        const clusterCenters: { x: number; y: number; cluster: number }[] = [];
        for (let c = 0; c < 6; c++) {
          const ci = dots.filter((d) => d.cluster === c);
          if (ci.length === 0) continue;
          let cx = 0, cy = 0;
          for (const d of ci) { cx += d.x; cy += d.y; }
          cx /= ci.length;
          cy /= ci.length;
          clusterCenters.push({ x: cx, y: cy, cluster: c });
        }

        for (const cc of clusterCenters) {
          const ci = dots.filter((d) => d.cluster === cc.cluster);
          let maxDist = 0;
          for (const d of ci) {
            const dx = d.x - cc.x;
            const dy = d.y - cc.y;
            maxDist = Math.max(maxDist, Math.sqrt(dx * dx + dy * dy));
          }
          const col = CLUSTER_COLORS[cc.cluster % CLUSTER_COLORS.length];
          const rr = maxDist + 15;

          ctx.beginPath();
          ctx.arc(cc.x, cc.y, rr, 0, Math.PI * 2);
          ctx.strokeStyle = `rgba(${col[0]}, ${col[1]}, ${col[2]}, ${ringAlpha})`;
          ctx.lineWidth = 1;
          ctx.setLineDash([4, 4]);
          ctx.stroke();
          ctx.setLineDash([]);
        }
      }

      const labels = ['Scattered', 'Clustering...', 'Building Routes...', 'Optimized', 'Reset'];
      const label = labels[s.phase];
      const labelAlpha = s.phase === Phase.DISSOLVE
        ? 1 - easeOutExpo(phaseT)
        : Math.min(1, phaseT * 4);

      // The phase in the bottom-left corner, clear of the hero; phones skip it.
      if (w >= 640) {
        ctx.font = '500 11px "Inter Variable", Inter, system-ui, sans-serif';
        ctx.fillStyle = `rgba(15, 23, 42, ${labelAlpha * 0.45})`;
        ctx.textAlign = 'left';
        const labelX = 40, labelY = h - 34;
        ctx.fillText(label, labelX, labelY);

        const totalPhases = PHASE_DURATIONS.length;
        const barW = 96;
        const barH = 2;
        const barY = labelY + 8;
        ctx.fillStyle = `rgba(15, 23, 42, 0.08)`;
        ctx.fillRect(labelX, barY, barW, barH);
        const filled = (s.phase + phaseT) / totalPhases;
        ctx.fillStyle = `rgba(200, 30, 45, 0.55)`;
        ctx.fillRect(labelX, barY, barW * filled, barH);
      }

      animRef.current = requestAnimationFrame(loop);
    };

    animRef.current = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(animRef.current);
      window.removeEventListener('resize', resize);
      window.removeEventListener('mousemove', onMouse);
    };
  }, [buildClusters]);

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 w-full h-full"
    />
  );
}

const titleVariants = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.035 } },
};

const charVariants = {
  hidden: { opacity: 0, y: 40, rotateX: -90 },
  visible: {
    opacity: 1,
    y: 0,
    rotateX: 0,
    transition: { duration: 0.6, ease: [0.16, 1, 0.3, 1] },
  },
};

function AnimatedTitle({ text, className }: { text: string; className?: string }) {
  return (
    <motion.h1
      className={className}
      variants={titleVariants}
      initial="hidden"
      animate="visible"
      style={{ perspective: 600 }}
    >
      {text.split('').map((char, i) => (
        <motion.span
          key={i}
          variants={charVariants}
          style={{ display: 'inline-block', transformStyle: 'preserve-3d' }}
        >
          {char === ' ' ? '\u00A0' : char}
        </motion.span>
      ))}
    </motion.h1>
  );
}

const PROMISES = [
  { icon: Map, title: "Territories that hold", text: "Balanced reps, no overlap between territories." },
  { icon: Route, title: "Days that drive less", text: "Every day in the visits band, short hops between stops." },
  { icon: FileSpreadsheet, title: "A journey plan in one file", text: "Dates, stops and map links, ready to roll out." },
];

export default function LandingPage({ onAdminLogin }: LandingPageProps) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setMounted(true), 200);
    return () => clearTimeout(timer);
  }, []);

  return (
    <div className="relative flex min-h-screen flex-col overflow-hidden bg-background">
      <div className="absolute inset-0">
        <OptimizationCanvas />
      </div>

      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'radial-gradient(ellipse 52% 48% at 50% 50%, rgba(245,247,250,0.94), rgba(245,247,250,0.7) 60%, rgba(245,247,250,0.1))',
        }}
      />

      <header className="relative z-10 flex items-center justify-between px-6 py-5 md:px-10">
        <div className="flex items-center gap-2.5">
          <BrandMark className="h-8 w-8" />
          <span className="text-[15px] font-semibold tracking-tight text-foreground">RouteOptima</span>
        </div>
        <Button variant="outline" size="sm" onClick={onAdminLogin} data-testid="button-header-sign-in">
          Sign in
        </Button>
      </header>

      <div className="relative z-10 flex flex-1 flex-col items-center justify-center px-6 pb-10">
        <AnimatePresence>
          {mounted && (
            <motion.div className="max-w-3xl text-center">
              <motion.div
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
                className="mb-7 inline-flex items-center gap-2 rounded-full border bg-card/80 px-3 py-1 text-xs font-medium text-muted-foreground shadow-xs backdrop-blur"
              >
                <span className="h-1.5 w-1.5 rounded-full bg-primary" />
                Route-to-market planning for field sales
              </motion.div>

              <motion.div
                initial={{ scale: 0.6, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
                className="mb-6 flex justify-center"
              >
                <BrandMark className="h-16 w-16 drop-shadow-[0_12px_24px_rgba(200,30,45,0.35)]" />
              </motion.div>

              <AnimatedTitle
                text="RouteOptima"
                className="mb-3 text-5xl font-semibold tracking-[-0.045em] text-foreground md:text-7xl"
              />

              <motion.p
                className="mb-4 text-xl font-medium tracking-tight text-primary md:text-2xl"
                initial={{ opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.7, delay: 0.5 }}
              >
                From chaos to optimal
              </motion.p>

              <motion.p
                className="mx-auto mb-9 max-w-xl text-base leading-relaxed text-muted-foreground md:text-lg"
                initial={{ opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.7, delay: 0.7 }}
              >
                Drop in your outlet list. RouteOptima sizes the team, draws the territories,
                cuts every rep's month into day routes and hands you the journey plan.
              </motion.p>

              <motion.div
                className="flex flex-col items-center gap-3"
                initial={{ opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.7, delay: 0.9 }}
              >
                <Button
                  onClick={onAdminLogin}
                  variant="brand"
                  size="lg"
                  className="group h-12 min-w-[240px] px-7 text-[15px] shadow-[0_10px_30px_-8px_rgba(200,30,45,0.55)]"
                  data-testid="button-sign-in"
                >
                  Sign in to your workspace
                  <ArrowRight className="transition-transform duration-200 group-hover:translate-x-1" />
                </Button>
                <p className="text-xs text-muted-foreground">Accounts are created by your administrator.</p>
              </motion.div>

              <motion.div
                className="mx-auto mt-14 grid max-w-3xl grid-cols-1 gap-3 text-left sm:grid-cols-3"
                initial={{ opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.7, delay: 1.1 }}
              >
                {PROMISES.map(({ icon: Icon, title, text }) => (
                  <div key={title} className="rounded-xl border bg-card/80 p-4 shadow-xs backdrop-blur">
                    <div className="mb-3 flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
                      <Icon className="h-4 w-4" />
                    </div>
                    <p className="text-sm font-semibold text-foreground">{title}</p>
                    <p className="mt-1 text-[13px] leading-snug text-muted-foreground">{text}</p>
                  </div>
                ))}
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <motion.footer
        className="relative z-10 py-6 text-center"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 1, delay: 1.4 }}
      >
        <p className="text-xs text-muted-foreground">Solution developed by Walid El Tayeh</p>
      </motion.footer>
    </div>
  );
}
