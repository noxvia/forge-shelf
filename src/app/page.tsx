import { LibraryGrid } from '@/components/LibraryGrid';

export const dynamic = 'force-dynamic';

export default function LibraryPage() {
  return (
    <>
      <h1 className="mb-5 text-2xl font-semibold tracking-tight">Library</h1>
      <LibraryGrid />
    </>
  );
}
