import { useState, useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Map, Plus, Minus } from "lucide-react";
import type { Outlet, Rep } from "@shared/schema";

// Territory colors matching the design
const territoryColors = [
  { name: "red", color: "#EF4444", bgColor: "bg-red-500" },
  { name: "blue", color: "#3B82F6", bgColor: "bg-blue-500" },
  { name: "green", color: "#10B981", bgColor: "bg-green-500" },
  { name: "yellow", color: "#F59E0B", bgColor: "bg-yellow-500" },
  { name: "purple", color: "#8B5CF6", bgColor: "bg-purple-500" },
];

export default function TerritoryMap() {
  const [selectedRep, setSelectedRep] = useState("all");
  const [selectedWeek, setSelectedWeek] = useState("current");
  const [mapZoom, setMapZoom] = useState(1);
  const mapRef = useRef<HTMLDivElement>(null);

  const { data: outlets = [] } = useQuery<Outlet[]>({
    queryKey: ["/api/outlets"],
  });

  const { data: reps = [] } = useQuery<Rep[]>({
    queryKey: ["/api/reps"],
  });

  // Group outlets by rep/territory for visualization
  const territoryGroups = outlets.reduce((groups, outlet) => {
    const territory = outlet.territory || "unassigned";
    if (!groups[territory]) {
      groups[territory] = [];
    }
    groups[territory].push(outlet);
    return groups;
  }, {} as Record<string, Outlet[]>);

  // Generate mock map markers based on outlet data
  const generateMapMarkers = () => {
    return Object.entries(territoryGroups).map(([territory, territoryOutlets], territoryIndex) => {
      const color = territoryColors[territoryIndex % territoryColors.length];
      
      return territoryOutlets.map((outlet, outletIndex) => {
        // Normalize coordinates to fit within the map container (0-100%)
        const normalizedLat = Math.min(Math.max((outlet.latitude + 90) / 180 * 100, 5), 95);
        const normalizedLng = Math.min(Math.max((outlet.longitude + 180) / 360 * 100, 5), 95);
        
        return {
          id: outlet.id,
          territory,
          color: color.color,
          bgColor: color.bgColor,
          lat: normalizedLat,
          lng: normalizedLng,
          name: outlet.name,
          visitFrequency: outlet.visitFrequency,
        };
      });
    }).flat();
  };

  const mapMarkers = generateMapMarkers();

  // Calculate territory stats
  const territoryStats = Object.entries(territoryGroups).map(([territory, territoryOutlets], index) => {
    const color = territoryColors[index % territoryColors.length];
    return {
      territory,
      count: territoryOutlets.length,
      color: color.color,
      bgColor: color.bgColor,
    };
  });

  return (
    <Card>
      <CardHeader>
        <div className="flex justify-between items-center">
          <CardTitle className="flex items-center">
            <Map className="mr-2 h-5 w-5 text-primary" />
            Territory Map
          </CardTitle>
          
          {/* Map Filters */}
          <div className="flex items-center space-x-3">
            <Select value={selectedRep} onValueChange={setSelectedRep}>
              <SelectTrigger className="w-48">
                <SelectValue placeholder="Select Rep" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Reps</SelectItem>
                {reps.map((rep) => (
                  <SelectItem key={rep.id} value={rep.id}>
                    {rep.name} - {rep.territory}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            
            <Select value={selectedWeek} onValueChange={setSelectedWeek}>
              <SelectTrigger className="w-32">
                <SelectValue placeholder="Week" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="current">Current Week</SelectItem>
                <SelectItem value="week1">Week 1</SelectItem>
                <SelectItem value="week2">Week 2</SelectItem>
                <SelectItem value="week3">Week 3</SelectItem>
                <SelectItem value="week4">Week 4</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      </CardHeader>
      
      <CardContent>
        {/* Map Container */}
        <div 
          ref={mapRef}
          className="h-96 bg-gray-100 rounded-lg relative overflow-hidden"
          style={{
            backgroundImage: "url('https://images.unsplash.com/photo-1524661135-423995f22d0b?ixlib=rb-4.0.3&ixid=MnwxMjA3fDB8MHxwaG90by1wYWdlfHx8fGVufDB8fHx8&auto=format&fit=crop&w=1000&h=600')",
            backgroundSize: "cover",
            backgroundPosition: "center",
            transform: `scale(${mapZoom})`,
            transformOrigin: "center center",
            transition: "transform 0.2s ease"
          }}
        >
          {/* Territory Overlay */}
          <div className="absolute inset-0 bg-primary/20"></div>
          
          {/* Outlet Markers */}
          {mapMarkers.map((marker) => (
            <div
              key={marker.id}
              className={`absolute w-3 h-3 ${marker.bgColor} rounded-full animate-pulse cursor-pointer hover:scale-150 transition-transform`}
              style={{
                top: `${marker.lat}%`,
                left: `${marker.lng}%`,
                transform: "translate(-50%, -50%)"
              }}
              title={`${marker.name} - VF${marker.visitFrequency} (${marker.territory})`}
            />
          ))}
          
          {/* Route Lines - simplified visualization */}
          <svg className="absolute inset-0 w-full h-full pointer-events-none">
            {territoryStats.slice(0, 3).map((territory, index) => {
              const paths = [
                "M 20 16 Q 32 24 44 32",
                "M 24 24 Q 36 32 48 40", 
                "M 28 32 Q 40 40 52 48"
              ];
              return (
                <path
                  key={territory.territory}
                  d={paths[index]}
                  stroke={territory.color}
                  strokeWidth="2"
                  fill="none"
                  opacity="0.7"
                />
              );
            })}
          </svg>
          
          {/* Map Controls */}
          <div className="absolute bottom-4 right-4 bg-white rounded-lg shadow-lg">
            <Button
              variant="ghost"
              size="sm"
              className="p-2 rounded-t-lg rounded-b-none"
              onClick={() => setMapZoom(prev => Math.min(prev + 0.2, 3))}
            >
              <Plus className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="p-2 rounded-b-lg rounded-t-none border-t"
              onClick={() => setMapZoom(prev => Math.max(prev - 0.2, 0.5))}
            >
              <Minus className="h-4 w-4" />
            </Button>
          </div>
          
          {/* Legend */}
          <div className="absolute top-4 left-4 bg-white rounded-lg shadow-lg p-3 max-w-48">
            <h4 className="text-sm font-semibold text-gray-900 mb-2">Legend</h4>
            <div className="space-y-1 text-xs">
              {territoryStats.slice(0, 5).map((territory) => (
                <div key={territory.territory} className="flex items-center">
                  <div className={`w-3 h-3 ${territory.bgColor} rounded-full mr-2`}></div>
                  <span className="capitalize">
                    {territory.territory} ({territory.count} outlets)
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Map Stats */}
        <div className="grid grid-cols-3 gap-4 mt-4">
          <div className="text-center">
            <p className="text-2xl font-bold text-gray-900">
              {Math.round(outlets.length * 0.12)}
            </p>
            <p className="text-sm text-gray-600">Total KM Today</p>
          </div>
          <div className="text-center">
            <p className="text-2xl font-bold text-gray-900">2.3</p>
            <p className="text-sm text-gray-600">Avg Travel Time (hrs)</p>
          </div>
          <div className="text-center">
            <p className="text-2xl font-bold text-gray-900">94%</p>
            <p className="text-sm text-gray-600">Visit Efficiency</p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
