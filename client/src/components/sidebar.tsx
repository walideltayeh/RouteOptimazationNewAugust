import { Link, useLocation } from "wouter";
import { 
  BarChart3, 
  Upload, 
  Settings, 
  Calendar, 
  Map, 
  FileText,
  Route,
  Car,
  Users
} from "lucide-react";

const navigation = [
  { name: "Dashboard", href: "/", icon: BarChart3 },
  { name: "Territory Map", href: "/territories", icon: Map },
  { name: "Rep Map", href: "/rep-map", icon: Route },
  { name: "Vehicles", href: "/vehicles", icon: Car },
];

export default function Sidebar() {
  const [location] = useLocation();

  return (
    <aside className="w-64 bg-white shadow-lg border-r border-gray-200 flex flex-col">
      <div className="p-6 border-b border-gray-200">
        <h1 className="text-2xl font-bold text-primary flex items-center">
          <Route className="mr-3 h-8 w-8" />
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
      
      <div className="p-4 border-t border-gray-200">
        <div className="flex items-center">
          <div className="w-8 h-8 bg-primary rounded-full flex items-center justify-center text-white text-sm font-medium">
            JD
          </div>
          <div className="ml-3">
            <p className="text-sm font-medium text-gray-900">John Doe</p>
            <p className="text-xs text-gray-500">Territory Manager</p>
          </div>
        </div>
      </div>
    </aside>
  );
}
