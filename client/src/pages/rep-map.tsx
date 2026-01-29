import { RepMap } from "@/components/rep-map";

export default function RepMapPage() {
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
          </div>
        </header>

        {/* Rep Map Component */}
        <div className="h-[calc(100vh-200px)]">
          <RepMap />
        </div>
      </div>
    </div>
  );
}