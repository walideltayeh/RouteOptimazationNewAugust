import { useState, useEffect, useRef, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { ArrowRight, LogIn } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

interface LandingPageProps {
  onStartTrial: () => void;
  onAdminLogin: () => void;
}

interface Node {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  cluster: number;
  pulsePhase: number;
  opacity: number;
}

interface Particle {
  progress: number;
  speed: number;
  fromNode: number;
  toNode: number;
  opacity: number;
}

const CLUSTER_COLORS = [
  { r: 139, g: 0, b: 0 },
  { r: 60, g: 60, b: 60 },
  { r: 139, g: 0, b: 0 },
  { r: 80, g: 80, b: 80 },
  { r: 139, g: 0, b: 0 },
];

function RouteCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const nodesRef = useRef<Node[]>([]);
  const particlesRef = useRef<Particle[]>([]);
  const edgesRef = useRef<[number, number][]>([]);
  const animFrameRef = useRef<number>(0);
  const timeRef = useRef(0);
  const mouseRef = useRef({ x: -1000, y: -1000 });

  const initNodes = useCallback((w: number, h: number) => {
    const nodes: Node[] = [];
    const clusterCenters = [
      { x: w * 0.15, y: h * 0.3 },
      { x: w * 0.35, y: h * 0.65 },
      { x: w * 0.55, y: h * 0.25 },
      { x: w * 0.75, y: h * 0.55 },
      { x: w * 0.88, y: h * 0.35 },
    ];

    const nodeCount = Math.min(65, Math.floor(w * h / 15000));

    for (let i = 0; i < nodeCount; i++) {
      const cluster = i % clusterCenters.length;
      const center = clusterCenters[cluster];
      const spread = Math.min(w, h) * 0.12;
      nodes.push({
        x: center.x + (Math.random() - 0.5) * spread * 2,
        y: center.y + (Math.random() - 0.5) * spread * 2,
        vx: (Math.random() - 0.5) * 0.15,
        vy: (Math.random() - 0.5) * 0.15,
        radius: 2 + Math.random() * 2.5,
        cluster,
        pulsePhase: Math.random() * Math.PI * 2,
        opacity: 0.4 + Math.random() * 0.4,
      });
    }
    nodesRef.current = nodes;

    const edges: [number, number][] = [];
    for (let c = 0; c < clusterCenters.length; c++) {
      const clusterNodes = nodes
        .map((n, i) => ({ n, i }))
        .filter(({ n }) => n.cluster === c);

      if (clusterNodes.length < 2) continue;

      const visited = new Set<number>();
      let current = clusterNodes[0].i;
      visited.add(current);

      while (visited.size < clusterNodes.length) {
        let nearest = -1;
        let nearestDist = Infinity;
        for (const { i } of clusterNodes) {
          if (visited.has(i)) continue;
          const dx = nodes[i].x - nodes[current].x;
          const dy = nodes[i].y - nodes[current].y;
          const d = dx * dx + dy * dy;
          if (d < nearestDist) {
            nearestDist = d;
            nearest = i;
          }
        }
        if (nearest >= 0) {
          edges.push([current, nearest]);
          visited.add(nearest);
          current = nearest;
        }
      }
      if (clusterNodes.length > 2) {
        edges.push([current, clusterNodes[0].i]);
      }
    }

    for (let c = 0; c < clusterCenters.length - 1; c++) {
      const nodesA = nodes.map((n, i) => ({ n, i })).filter(({ n }) => n.cluster === c);
      const nodesB = nodes.map((n, i) => ({ n, i })).filter(({ n }) => n.cluster === c + 1);
      if (nodesA.length > 0 && nodesB.length > 0) {
        let bestA = 0, bestB = 0, bestDist = Infinity;
        for (const a of nodesA) {
          for (const b of nodesB) {
            const dx = a.n.x - b.n.x;
            const dy = a.n.y - b.n.y;
            const d = dx * dx + dy * dy;
            if (d < bestDist) { bestDist = d; bestA = a.i; bestB = b.i; }
          }
        }
        edges.push([bestA, bestB]);
      }
    }

    edgesRef.current = edges;

    const particles: Particle[] = [];
    const particleCount = Math.min(30, edges.length * 2);
    for (let i = 0; i < particleCount; i++) {
      const edgeIdx = Math.floor(Math.random() * edges.length);
      particles.push({
        progress: Math.random(),
        speed: 0.002 + Math.random() * 0.004,
        fromNode: edges[edgeIdx][0],
        toNode: edges[edgeIdx][1],
        opacity: 0.3 + Math.random() * 0.5,
      });
    }
    particlesRef.current = particles;
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      ctx.scale(dpr, dpr);
      initNodes(rect.width, rect.height);
    };

    resize();
    window.addEventListener('resize', resize);

    const handleMouseMove = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      mouseRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };
    canvas.addEventListener('mousemove', handleMouseMove);

    const animate = () => {
      const rect = canvas.getBoundingClientRect();
      const w = rect.width;
      const h = rect.height;
      timeRef.current += 0.016;
      const t = timeRef.current;

      ctx.clearRect(0, 0, w, h);

      const nodes = nodesRef.current;
      const edges = edgesRef.current;
      const particles = particlesRef.current;
      const mouse = mouseRef.current;

      for (const node of nodes) {
        node.x += node.vx;
        node.y += node.vy;

        const dx = mouse.x - node.x;
        const dy = mouse.y - node.y;
        const md = Math.sqrt(dx * dx + dy * dy);
        if (md < 120 && md > 0) {
          const force = (120 - md) / 120 * 0.3;
          node.vx -= (dx / md) * force;
          node.vy -= (dy / md) * force;
        }

        node.vx *= 0.98;
        node.vy *= 0.98;

        if (node.x < 10) node.vx += 0.05;
        if (node.x > w - 10) node.vx -= 0.05;
        if (node.y < 10) node.vy += 0.05;
        if (node.y > h - 10) node.vy -= 0.05;
      }

      for (const [a, b] of edges) {
        const nA = nodes[a];
        const nB = nodes[b];
        if (!nA || !nB) continue;

        const isCrossCluster = nA.cluster !== nB.cluster;
        const color = isCrossCluster
          ? `rgba(139, 0, 0, 0.06)`
          : `rgba(139, 0, 0, ${0.08 + Math.sin(t * 0.5 + a) * 0.03})`;

        ctx.beginPath();
        ctx.moveTo(nA.x, nA.y);
        ctx.lineTo(nB.x, nB.y);
        ctx.strokeStyle = color;
        ctx.lineWidth = isCrossCluster ? 0.5 : 1;
        ctx.stroke();
      }

      for (const p of particles) {
        p.progress += p.speed;
        if (p.progress >= 1) {
          p.progress = 0;
          const edgeIdx = Math.floor(Math.random() * edges.length);
          p.fromNode = edges[edgeIdx][0];
          p.toNode = edges[edgeIdx][1];
          p.opacity = 0.3 + Math.random() * 0.5;
        }

        const from = nodes[p.fromNode];
        const to = nodes[p.toNode];
        if (!from || !to) continue;

        const px = from.x + (to.x - from.x) * p.progress;
        const py = from.y + (to.y - from.y) * p.progress;
        const fadeIn = p.progress < 0.1 ? p.progress / 0.1 : 1;
        const fadeOut = p.progress > 0.9 ? (1 - p.progress) / 0.1 : 1;
        const alpha = p.opacity * fadeIn * fadeOut;

        ctx.beginPath();
        ctx.arc(px, py, 1.5, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(139, 0, 0, ${alpha})`;
        ctx.fill();
      }

      for (const node of nodes) {
        const pulse = Math.sin(t * 1.5 + node.pulsePhase) * 0.3 + 0.7;
        const col = CLUSTER_COLORS[node.cluster % CLUSTER_COLORS.length];
        const r = node.radius * pulse;

        const glow = ctx.createRadialGradient(node.x, node.y, 0, node.x, node.y, r * 4);
        glow.addColorStop(0, `rgba(${col.r}, ${col.g}, ${col.b}, ${node.opacity * 0.15})`);
        glow.addColorStop(1, `rgba(${col.r}, ${col.g}, ${col.b}, 0)`);
        ctx.beginPath();
        ctx.arc(node.x, node.y, r * 4, 0, Math.PI * 2);
        ctx.fillStyle = glow;
        ctx.fill();

        ctx.beginPath();
        ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${col.r}, ${col.g}, ${col.b}, ${node.opacity * pulse})`;
        ctx.fill();
      }

      animFrameRef.current = requestAnimationFrame(animate);
    };

    animFrameRef.current = requestAnimationFrame(animate);

    return () => {
      cancelAnimationFrame(animFrameRef.current);
      window.removeEventListener('resize', resize);
      canvas.removeEventListener('mousemove', handleMouseMove);
    };
  }, [initNodes]);

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 w-full h-full"
      style={{ opacity: 0.85 }}
    />
  );
}

const wordVariants = {
  hidden: {},
  visible: {
    transition: { staggerChildren: 0.04 },
  },
};

const letterVariants = {
  hidden: { opacity: 0, y: 30, filter: 'blur(8px)' },
  visible: {
    opacity: 1,
    y: 0,
    filter: 'blur(0px)',
    transition: { duration: 0.5, ease: [0.25, 0.46, 0.45, 0.94] },
  },
};

function AnimatedTitle({ text, className }: { text: string; className?: string }) {
  return (
    <motion.h1
      className={className}
      variants={wordVariants}
      initial="hidden"
      animate="visible"
    >
      {text.split('').map((char, i) => (
        <motion.span key={i} variants={letterVariants} style={{ display: 'inline-block' }}>
          {char === ' ' ? '\u00A0' : char}
        </motion.span>
      ))}
    </motion.h1>
  );
}

export default function LandingPage({ onStartTrial, onAdminLogin }: LandingPageProps) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  return (
    <div className="min-h-screen bg-white flex flex-col relative overflow-hidden">
      <div className="absolute inset-0 pointer-events-none">
        <RouteCanvas />
      </div>

      <div className="absolute inset-0 pointer-events-none" style={{
        background: 'radial-gradient(ellipse 60% 50% at 50% 50%, rgba(255,255,255,0.95), rgba(255,255,255,0.7), rgba(255,255,255,0.3))',
      }} />

      <div className="flex-1 flex flex-col items-center justify-center px-6 relative z-10">
        <AnimatePresence>
          {mounted && (
            <motion.div className="text-center max-w-2xl">
              <motion.div
                initial={{ scale: 0, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
                className="mb-8"
              >
                <div className="w-16 h-16 mx-auto relative">
                  <motion.div
                    className="absolute inset-0 rounded-2xl bg-[#8B0000]"
                    animate={{ rotate: [0, 90, 180, 270, 360] }}
                    transition={{ duration: 20, repeat: Infinity, ease: 'linear' }}
                    style={{ opacity: 0.08 }}
                  />
                  <div className="absolute inset-1 rounded-xl bg-white flex items-center justify-center">
                    <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
                      <motion.path
                        d="M14 3L14 25"
                        stroke="#8B0000"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        initial={{ pathLength: 0 }}
                        animate={{ pathLength: 1 }}
                        transition={{ duration: 1, delay: 0.5 }}
                      />
                      <motion.path
                        d="M3 14L25 14"
                        stroke="#8B0000"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        initial={{ pathLength: 0 }}
                        animate={{ pathLength: 1 }}
                        transition={{ duration: 1, delay: 0.7 }}
                      />
                      <motion.circle
                        cx="14"
                        cy="14"
                        r="4"
                        stroke="#8B0000"
                        strokeWidth="1.5"
                        fill="none"
                        initial={{ pathLength: 0 }}
                        animate={{ pathLength: 1 }}
                        transition={{ duration: 1, delay: 0.9 }}
                      />
                      <motion.circle
                        cx="14"
                        cy="6"
                        r="2"
                        fill="#8B0000"
                        initial={{ scale: 0 }}
                        animate={{ scale: 1 }}
                        transition={{ duration: 0.3, delay: 1.2 }}
                      />
                      <motion.circle
                        cx="22"
                        cy="14"
                        r="2"
                        fill="#8B0000"
                        initial={{ scale: 0 }}
                        animate={{ scale: 1 }}
                        transition={{ duration: 0.3, delay: 1.3 }}
                      />
                      <motion.circle
                        cx="14"
                        cy="22"
                        r="2"
                        fill="#8B0000"
                        initial={{ scale: 0 }}
                        animate={{ scale: 1 }}
                        transition={{ duration: 0.3, delay: 1.4 }}
                      />
                      <motion.circle
                        cx="6"
                        cy="14"
                        r="2"
                        fill="#8B0000"
                        initial={{ scale: 0 }}
                        animate={{ scale: 1 }}
                        transition={{ duration: 0.3, delay: 1.5 }}
                      />
                    </svg>
                  </div>
                </div>
              </motion.div>

              <AnimatedTitle
                text="RouteOptima"
                className="text-5xl md:text-7xl font-semibold text-[#1d1d1f] tracking-tight mb-4"
              />

              <motion.p
                className="text-xl md:text-2xl text-[#86868b] font-light mb-3"
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.8, delay: 0.6 }}
              >
                Intelligent Route Optimization
              </motion.p>

              <motion.p
                className="text-base text-[#86868b] max-w-md mx-auto mb-12"
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.8, delay: 0.8 }}
              >
                Optimize your sales territories and routes with precision.
                Maximize productivity, minimize travel time.
              </motion.p>

              <motion.div
                className="flex flex-col sm:flex-row items-center justify-center gap-4"
                initial={{ opacity: 0, y: 30 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.8, delay: 1.0 }}
              >
                <motion.div whileHover={{ scale: 1.04 }} whileTap={{ scale: 0.97 }}>
                  <Button
                    onClick={onStartTrial}
                    size="lg"
                    className="bg-[#8B0000] hover:bg-[#6B0000] text-white px-8 py-6 text-lg rounded-full min-w-[200px] group shadow-lg shadow-[#8B0000]/20 hover:shadow-xl hover:shadow-[#8B0000]/30 transition-shadow"
                  >
                    Start Free Trial
                    <ArrowRight className="ml-2 h-5 w-5 group-hover:translate-x-1 transition-transform" />
                  </Button>
                </motion.div>

                <motion.div whileHover={{ scale: 1.04 }} whileTap={{ scale: 0.97 }}>
                  <Button
                    onClick={onAdminLogin}
                    variant="outline"
                    size="lg"
                    className="border-[#1d1d1f] text-[#1d1d1f] hover:bg-[#1d1d1f] hover:text-white px-8 py-6 text-lg rounded-full min-w-[200px]"
                  >
                    <LogIn className="mr-2 h-5 w-5" />
                    Admin / Super User Login
                  </Button>
                </motion.div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <motion.footer
        className="py-6 text-center relative z-10"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 1, delay: 1.2 }}
      >
        <p className="text-xs text-[#86868b]">Solution developed by Walid El Tayeh</p>
      </motion.footer>
    </div>
  );
}
