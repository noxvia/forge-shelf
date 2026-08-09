import { PlateWorkspace } from '@/components/PlateWorkspace';

export const dynamic = 'force-dynamic';

export default function PlatePage({ params }: { params: { id: string } }) {
  return <PlateWorkspace plateId={params.id} />;
}
