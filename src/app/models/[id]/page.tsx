import { ModelDetail } from '@/components/ModelDetail';

export const dynamic = 'force-dynamic';

export default function ModelPage({ params }: { params: { id: string } }) {
  return <ModelDetail modelId={params.id} />;
}
