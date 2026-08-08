import { prisma } from '@/lib/db';
import { ok, handler } from '@/lib/json';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = handler(async () => {
  const tags = await prisma.tag.findMany({
    orderBy: { name: 'asc' },
    include: { _count: { select: { models: true } } },
  });
  return ok(
    tags.map((t) => ({
      id: t.id,
      name: t.name,
      slug: t.slug,
      color: t.color,
      count: t._count.models,
    })),
  );
});
