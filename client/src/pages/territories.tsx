import TerritoryMap from '@/components/territory-map';
import PageShell from '@/components/page-shell';

export default function TerritoriesPage() {
  return (
    <PageShell wide>
      <TerritoryMap className="h-full" />
    </PageShell>
  );
}
