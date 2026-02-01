import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { ArrowRight, LogIn } from 'lucide-react';

interface LandingPageProps {
  onStartTrial: () => void;
  onAdminLogin: () => void;
}

export default function LandingPage({ onStartTrial, onAdminLogin }: LandingPageProps) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  return (
    <div className="min-h-screen bg-white flex flex-col">
      <div className="flex-1 flex flex-col items-center justify-center px-6 relative overflow-hidden">
        <div className="absolute inset-0 overflow-hidden pointer-events-none">
          <svg className="absolute w-full h-full" viewBox="0 0 1200 800" preserveAspectRatio="xMidYMid slice">
            <defs>
              <linearGradient id="routeGradient" x1="0%" y1="0%" x2="100%" y2="0%">
                <stop offset="0%" stopColor="#8B0000" stopOpacity="0.1" />
                <stop offset="50%" stopColor="#8B0000" stopOpacity="0.3" />
                <stop offset="100%" stopColor="#8B0000" stopOpacity="0.1" />
              </linearGradient>
            </defs>
            
            <path
              d="M-100,400 Q200,200 400,350 T700,300 T1000,400 T1300,350"
              fill="none"
              stroke="url(#routeGradient)"
              strokeWidth="2"
              className={`transition-all duration-[3000ms] ease-out ${mounted ? 'opacity-100' : 'opacity-0'}`}
              style={{
                strokeDasharray: 2000,
                strokeDashoffset: mounted ? 0 : 2000,
                transition: 'stroke-dashoffset 3s ease-out, opacity 1s ease-out'
              }}
            />
            
            <path
              d="M-50,500 Q250,600 500,450 T850,500 T1250,450"
              fill="none"
              stroke="url(#routeGradient)"
              strokeWidth="1.5"
              className={`transition-all duration-[3500ms] ease-out ${mounted ? 'opacity-100' : 'opacity-0'}`}
              style={{
                strokeDasharray: 2000,
                strokeDashoffset: mounted ? 0 : 2000,
                transition: 'stroke-dashoffset 3.5s ease-out 0.3s, opacity 1s ease-out 0.3s'
              }}
            />
            
            <path
              d="M-100,250 Q300,150 550,280 T900,200 T1300,280"
              fill="none"
              stroke="url(#routeGradient)"
              strokeWidth="1"
              className={`transition-all duration-[4000ms] ease-out ${mounted ? 'opacity-100' : 'opacity-0'}`}
              style={{
                strokeDasharray: 2000,
                strokeDashoffset: mounted ? 0 : 2000,
                transition: 'stroke-dashoffset 4s ease-out 0.6s, opacity 1s ease-out 0.6s'
              }}
            />
            
            {[
              { cx: 400, cy: 350, delay: '1s' },
              { cx: 700, cy: 300, delay: '1.3s' },
              { cx: 1000, cy: 400, delay: '1.6s' },
              { cx: 500, cy: 450, delay: '1.9s' },
              { cx: 850, cy: 500, delay: '2.2s' },
              { cx: 550, cy: 280, delay: '2.5s' },
            ].map((point, i) => (
              <circle
                key={i}
                cx={point.cx}
                cy={point.cy}
                r="6"
                fill="#8B0000"
                className={`transition-all duration-500 ${mounted ? 'opacity-40' : 'opacity-0'}`}
                style={{ transitionDelay: point.delay }}
              />
            ))}
          </svg>
        </div>
        
        <div className={`relative z-10 text-center max-w-2xl transition-all duration-1000 ${mounted ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-8'}`}>
          <h1 className="text-5xl md:text-6xl font-semibold text-[#1d1d1f] tracking-tight mb-4">
            RouteOptima
          </h1>
          
          <p className="text-xl md:text-2xl text-[#86868b] font-light mb-3">
            Intelligent Route Optimization
          </p>
          
          <p className="text-base text-[#86868b] max-w-md mx-auto mb-12">
            Optimize your sales territories and routes with precision. 
            Maximize productivity, minimize travel time.
          </p>
          
          <div className={`flex flex-col sm:flex-row items-center justify-center gap-4 transition-all duration-1000 delay-500 ${mounted ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4'}`}>
            <Button 
              onClick={onStartTrial}
              size="lg"
              className="bg-[#8B0000] hover:bg-[#6B0000] text-white px-8 py-6 text-lg rounded-full min-w-[200px] group"
            >
              Start Free Trial
              <ArrowRight className="ml-2 h-5 w-5 group-hover:translate-x-1 transition-transform" />
            </Button>
            
            <Button 
              onClick={onAdminLogin}
              variant="outline"
              size="lg"
              className="border-[#1d1d1f] text-[#1d1d1f] hover:bg-[#1d1d1f] hover:text-white px-8 py-6 text-lg rounded-full min-w-[200px]"
            >
              <LogIn className="mr-2 h-5 w-5" />
              Admin / Super User Login
            </Button>
          </div>
        </div>
      </div>
      
      <footer className={`py-6 text-center transition-all duration-1000 delay-700 ${mounted ? 'opacity-100' : 'opacity-0'}`}>
        <p className="text-xs text-[#86868b]">Solution developed by Walid El Tayeh</p>
      </footer>
    </div>
  );
}
