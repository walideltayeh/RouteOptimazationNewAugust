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
  Car,
  Users,
  LogIn,
  LogOut,
  Shield
} from "lucide-react";
import { Button } from "@/components/ui/button";
import LoginModal from "@/components/login-modal";

const navigation = [
  { name: "Dashboard", href: "/", icon: BarChart3 },
  { name: "Territory Map", href: "/territories", icon: Map },
  { name: "Rep Map", href: "/rep-map", icon: Route },
  { name: "Vehicles", href: "/vehicles", icon: Car },
];

interface AuthStatus {
  isAuthenticated: boolean;
  isSuperuser: boolean;
  isTrialMode: boolean;
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
      queryClient.invalidateQueries({ queryKey: ["/api/trial/status"] });
      window.location.reload();
    }
  });

  return (
    <aside className="w-64 bg-white shadow-lg border-r border-gray-200 flex flex-col">
      <div className="p-6 border-b border-gray-200">
        <h1 className="text-2xl font-bold text-primary flex items-center">
          <img src="/logo.png" alt="RouteOptima" className="mr-3 h-8 w-8" />
          RouteOptima
        </h1>
        <p className="text-sm text-gray-600 mt-1">Sales Rep Route Optimizer</p>
      </div>
      
      <nav className="flex-1 p-4">
        <ul className="space-y-2">
          {navigation.map((item) => {
            const Icon = item.icon;
            const isActive = location === item.href;
            
            return (
              <li key={item.name}>
                <Link
                  href={item.href}
                  className={`nav-link ${isActive ? 'active' : ''}`}
                  onClick={() => console.log(`Navigating to: ${item.href}`)}
                >
                  <Icon className="mr-3 h-5 w-5" />
                  {item.name}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
      
      <div className="p-4 border-t border-gray-200 space-y-3">
        {authStatus?.isSuperuser ? (
          <div className="flex items-center justify-between">
            <div className="flex items-center">
              <div className="w-8 h-8 bg-green-600 rounded-full flex items-center justify-center text-white text-sm font-medium">
                <Shield className="h-4 w-4" />
              </div>
              <div className="ml-3">
                <p className="text-sm font-medium text-gray-900">Admin</p>
                <p className="text-xs text-green-600">Full Access</p>
              </div>
            </div>
            <Button 
              variant="ghost" 
              size="sm"
              onClick={() => logoutMutation.mutate()}
              disabled={logoutMutation.isPending}
            >
              <LogOut className="h-4 w-4" />
            </Button>
          </div>
        ) : (
          <Button 
            variant="outline" 
            className="w-full justify-start"
            onClick={() => setShowLoginModal(true)}
          >
            <LogIn className="mr-2 h-4 w-4" />
            Admin Login
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
