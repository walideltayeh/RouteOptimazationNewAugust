import { Link, useLocation } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useState } from "react";
import { 
  BarChart3, 
  Upload, 
  Settings, 
  Calendar, 
  Map, 
  FileText,
  Route,
  CalendarDays,
  FlaskConical,
  Users,
  LogIn,
  LogOut,
  Shield
} from "lucide-react";
import { Button } from "@/components/ui/button";
import LoginModal from "@/components/login-modal";
import pinLogo from "@assets/image_1769535972472.png";

const navigation = [
  { name: "Dashboard", href: "/", icon: BarChart3 },
  { name: "Territory Map", href: "/territories", icon: Map },
  { name: "Rep Map", href: "/rep-map", icon: Route },
  { name: "Schedules", href: "/schedules", icon: CalendarDays },
  { name: "Scenarios", href: "/scenarios", icon: FlaskConical },
];

interface AuthStatus {
  isAuthenticated: boolean;
  isSuperuser: boolean;
}

export default function Sidebar() {
  const [location] = useLocation();
  const [showLoginModal, setShowLoginModal] = useState(false);
  
  const { data: authStatus } = useQuery<AuthStatus>({
    queryKey: ["/api/auth/status"],
  });
  
  const logoutMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("POST", "/api/auth/logout");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/auth/status"] });
      window.location.reload();
    }
  });

  return (
    <aside className="w-72 bg-[#fafafa] dark:bg-[#1c1c1e] border-r border-[#e5e5e5] dark:border-[#38383a] flex flex-col">
      <div className="p-6 pb-4">
        <div className="flex items-center">
          <img 
            src={pinLogo} 
            alt="RouteOptima" 
            className="h-12 w-12 object-contain"
          />
          <div className="ml-3">
            <h1 className="text-lg font-semibold text-[#1d1d1f] dark:text-white tracking-tight">
              RouteOptima
            </h1>
            <p className="text-xs text-[#86868b] dark:text-[#98989d]">Route Optimizer</p>
          </div>
        </div>
      </div>
      
      <nav className="flex-1 px-3">
        <div className="space-y-1">
          {navigation.map((item) => {
            const Icon = item.icon;
            const isActive = location === item.href;
            
            return (
              <Link
                key={item.name}
                href={item.href}
                className={`
                  group flex items-center px-4 py-2.5 text-sm font-medium rounded-full transition-all duration-200
                  ${isActive 
                    ? 'bg-[#1d1d1f] text-white shadow-sm' 
                    : 'text-[#1d1d1f] dark:text-[#f5f5f7] hover:bg-[#e8e8ed] dark:hover:bg-[#2c2c2e]'
                  }
                `}
              >
                <Icon className={`mr-3 h-5 w-5 flex-shrink-0 ${isActive ? 'text-white' : 'text-[#86868b] group-hover:text-[#1d1d1f] dark:group-hover:text-white'}`} />
                {item.name}
              </Link>
            );
          })}
        </div>
      </nav>
      
      <div className="p-4 mx-3 mb-3 rounded-2xl bg-white dark:bg-[#2c2c2e] shadow-apple">
        {authStatus?.isSuperuser ? (
          <div className="flex items-center justify-between">
            <div className="flex items-center">
              <div className="w-9 h-9 bg-gradient-to-br from-green-500 to-green-600 rounded-full flex items-center justify-center shadow-sm">
                <Shield className="h-4 w-4 text-white" />
              </div>
              <div className="ml-3">
                <p className="text-sm font-medium text-[#1d1d1f] dark:text-white">Admin</p>
                <p className="text-xs text-green-600 dark:text-green-400">Full Access</p>
              </div>
            </div>
            <Button 
              variant="ghost" 
              size="icon"
              className="h-8 w-8 hover:bg-[#f5f5f7] dark:hover:bg-[#3a3a3c]"
              onClick={() => logoutMutation.mutate()}
              disabled={logoutMutation.isPending}
            >
              <LogOut className="h-4 w-4 text-[#86868b]" />
            </Button>
          </div>
        ) : (
          <Button 
            variant="ghost" 
            className="w-full justify-start h-10 text-[#1d1d1f] dark:text-white hover:bg-[#f5f5f7] dark:hover:bg-[#3a3a3c]"
            onClick={() => setShowLoginModal(true)}
          >
            <LogIn className="mr-2 h-4 w-4 text-[#86868b]" />
            <span className="text-sm font-medium">Admin Login</span>
          </Button>
        )}
      </div>
      
      <LoginModal 
        isOpen={showLoginModal}
        onClose={() => setShowLoginModal(false)}
        onLoginSuccess={() => setShowLoginModal(false)}
      />
    </aside>
  );
}
