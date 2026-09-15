import { RepMap } from "@/components/rep-map";

export default function RepMapPage() {
  // No page-level header card here: the component's own toolbar already names
  // the page, and the second title just pushed the map further down a screen
  // whose whole purpose is the map. Full height, so the map fills what is left
  // after the toolbar rather than starting below the fold.
  return (
    <div className="h-screen p-4 lg:p-6">
      <RepMap />
    </div>
  );
}
