import TerritoryMapGoogle from '@/components/territory-map-new';
import TerritoryMapMapbox from '@/components/territory-map';
import { useEffect, useState } from 'react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Map } from 'lucide-react';

type MapProvider = 'mapbox' | 'google';

export default function TerritoriesPage() {
  const [mapProvider, setMapProvider] = useState<MapProvider>(() => {
    const saved = localStorage.getItem('preferred_map_provider');
    return (saved as MapProvider) || 'mapbox';
  });

  useEffect(() => {
    console.log('TerritoriesPage component mounted');
  }, []);

  useEffect(() => {
    localStorage.setItem('preferred_map_provider', mapProvider);
  }, [mapProvider]);

  return (
    <div className="p-6 h-full">
      <div className="max-w-7xl mx-auto">
        <div className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold text-gray-900">Territory Map</h1>
            <p className="text-gray-600 mt-2">
              Visualize outlet distribution across sales territories
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
        {mapProvider === 'google' ? (
          <TerritoryMapGoogle className="h-full" />
        ) : (
          <TerritoryMapMapbox className="h-full" />
        )}
      </div>
    </div>
  );
}