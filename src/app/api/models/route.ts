import { z } from 'zod';
import { FileKind, Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { ok, handler, HttpError } from '@/lib/json';
import { uniqueSlug } from '@/lib/slug';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const listQuery = z.object({
  q: z.string().trim().optional(),
  tag: z.string().trim().optional(),
  collection: z.string().trim().optional(),
  favorite: z.enum(['true', 'false']).optional(),
  /** Only models that already have machine-ready files. */
  printable: z.enum(['true', 'false']).optional(),
  sort: z.enum(['recent', 'name', 'prints', 'size']).default('recent'),
  take: z.coerce.number().int().min(1).max(200).default(60),
  skip: z.coerce.number().int().min(0).default(0),
});

export const GET = handler(async (req: Request) => {
  const url = new URL(req.url);
  const parsed = listQuery.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) throw new HttpError(parsed.error.issues[0].message, 422);
  const { q, tag, collection, favorite, printable, sort, take, skip } = parsed.data;

  const where: Prisma.ModelWhereInput = {};

  if (q) {
    where.OR = [
      { name: { contains: q, mode: 'insensitive' } },
      { description: { contains: q, mode: 'insensitive' } },
      { designer: { contains: q, mode: 'insensitive' } },
      { notes: { contains: q, mode: 'insensitive' } },
      { files: { some: { filename: { contains: q, mode: 'insensitive' } } } },
      { tags: { some: { name: { contains: q, mode: 'insensitive' } } } },
    ];
  }
  if (tag) where.tags = { some: { slug: tag } };
  if (collection) where.collections = { some: { slug: collection } };
  if (favorite) where.favorite = favorite === 'true';
  if (printable === 'true') where.files = { some: { kind: FileKind.SLICED } };

  const orderBy: Prisma.ModelOrderByWithRelationInput =
    sort === 'name'
      ? { name: 'asc' }
      : sort === 'prints'
        ? { printCount: 'desc' }
        : { createdAt: 'desc' };

  const [items, total] = await Promise.all([
    prisma.model.findMany({
      where,
      orderBy,
      take,
      skip,
      include: {
        tags: { select: { id: true, name: true, slug: true, color: true } },
        files: {
          select: { id: true, kind: true, filename: true, sizeBytes: true, technology: true },
        },
      },
    }),
    prisma.model.count({ where }),
  ]);

  return ok({ items, total, take, skip });
});

const createBody = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(5000).optional(),
  designer: z.string().trim().max(200).optional(),
  sourceUrl: z.string().trim().url().max(2000).optional().or(z.literal('')),
  license: z.string().trim().max(200).optional(),
  notes: z.string().trim().max(5000).optional(),
  tags: z.array(z.string().trim().min(1).max(60)).max(30).optional(),
});

export const POST = handler(async (req: Request) => {
  const parsed = createBody.safeParse(await req.json());
  if (!parsed.success) throw new HttpError(parsed.error.issues[0].message, 422);
  const { tags, sourceUrl, ...rest } = parsed.data;

  const slug = await uniqueSlug(rest.name, async (candidate) =>
    Boolean(await prisma.model.findUnique({ where: { slug: candidate }, select: { id: true } })),
  );

  const model = await prisma.model.create({
    data: {
      ...rest,
      sourceUrl: sourceUrl || null,
      slug,
      tags: tags?.length ? { connect: await resolveTags(tags) } : undefined,
    },
    include: { tags: true, files: true },
  });

  return ok(model, { status: 201 });
});

/** Creates any tag that doesn't exist yet, then returns connect targets. */
async function resolveTags(names: string[]): Promise<{ id: string }[]> {
  const { slugify } = await import('@/lib/slug');
  const out: { id: string }[] = [];
  for (const name of [...new Set(names)]) {
    const slug = slugify(name);
    const tag = await prisma.tag.upsert({
      where: { slug },
      update: {},
      create: { name, slug },
      select: { id: true },
    });
    out.push(tag);
  }
  return out;
}
