import { RepMap } from "@/components/rep-map";
import { useState, useEffect } from 'react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Map, AlertCircle } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';

type MapProvider = 'mapbox' | 'google';

export default function RepMapPage() {
  const [mapProvider, setMapProvider] = useState<MapProvider>(() => {
    const saved = localStorage.getItem('preferred_map_provider');
    return (saved as MapProvider) || 'mapbox';
  });

  useEffect(() => {
    localStorage.setItem('preferred_map_provider', mapProvider);
  }, [mapProvider]);

  return (
    <div className="p-6">
      <div className="max-w-7xl mx-auto space-y-6">
        {/* Header */}
        <header className="bg-white shadow-sm border-b border-gray-200 px-6 py-4 rounded-lg">
          <div className="flex justify-between items-center">
            <div>
              <h2 className="text-2xl font-bold text-gray-900">Rep Map</h2>
              <p className="text-sm text-gray-600 mt-1">
                View and compare sales rep routes and schedules on an interactive map
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Map className="h-4 w-4 text-gray-500" />
              <Select value={mapProvider} onValueChange={(v) => setMapProvider(v as MapProvider)}>
                <SelectTrigger className="w-[160px]">
                  <SelectValue placeholder="Map Provider" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="mapbox">Mapbox</SelectItem>
                  <SelectItem value="google">Google Maps</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </header>

        {/* Rep Map Component */}
        <div className="h-[calc(100vh-200px)]">
          {mapProvider === 'google' ? (
            <div className="h-full flex items-center justify-center bg-gray-50 rounded-lg border">
              <Alert className="max-w-md">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>
                  Google Maps requires billing to be enabled on your Google Cloud account. 
                  Please use Mapbox for now, or enable billing in your Google Cloud Console.
                </AlertDescription>
              </Alert>
            </div>
          ) : (
            <RepMap />
          )}
        </div>
      </div>
    </div>
  );
}