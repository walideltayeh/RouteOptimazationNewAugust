import TerritoryMap from '@/components/territory-map-new';
import { useEffect } from 'react';

export default function TerritoriesPage() {
  useEffect(() => {
    console.log('TerritoriesPage component mounted');
  }, []);

  return (
    <div className="p-6 h-full">
      <div className="max-w-7xl mx-auto">
        <div className="mb-6">
          <h1 className="text-3xl font-bold text-gray-900">Territory Map</h1>
          <p className="text-gray-600 mt-2">
            Visualize outlet distribution across sales territories
          </p>
        </div>
        <TerritoryMap className="h-full" />
      </div>
    </div>
  );
}