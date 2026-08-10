import { z } from 'zod';
import { prisma } from '@/lib/db';
import { ok, handler, HttpError } from '@/lib/json';
import { removeModelTree } from '@/lib/storage';
import { slugify } from '@/lib/slug';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: { id: string } };

export const GET = handler(async (_req: Request, { params }: Ctx) => {
  const model = await prisma.model.findUnique({
    where: { id: params.id },
    include: {
      tags: true,
      collections: true,
      files: { orderBy: [{ kind: 'asc' }, { createdAt: 'asc' }] },
      jobs: {
        orderBy: { queuedAt: 'desc' },
        take: 20,
        include: { printer: { select: { id: true, name: true, kind: true } } },
      },
    },
  });
  if (!model) throw new HttpError('Model not found', 404);


  // Resolve which uploaded image is the cover here, so the client never has to
  // reason about storage paths.
  const coverFileId =
    model.files.find((f) => f.storagePath === model.thumbnailPath)?.id ?? null;

  return ok({ ...model, coverFileId });
});

const patchBody = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(5000).nullable().optional(),
  designer: z.string().trim().max(200).nullable().optional(),
  sourceUrl: z.string().trim().max(2000).nullable().optional(),
  license: z.string().trim().max(200).nullable().optional(),
  notes: z.string().trim().max(5000).nullable().optional(),
  favorite: z.boolean().optional(),
  /** Full replacement set of tag names. */
  tags: z.array(z.string().trim().min(1).max(60)).max(30).optional(),
});

export const PATCH = handler(async (req: Request, { params }: Ctx) => {
  const parsed = patchBody.safeParse(await req.json());
  if (!parsed.success) throw new HttpError(parsed.error.issues[0].message, 422);
  const { tags, ...rest } = parsed.data;

  const exists = await prisma.model.findUnique({
    where: { id: params.id },
    select: { id: true },
  });
  if (!exists) throw new HttpError('Model not found', 404);

  let tagOp;
  if (tags) {
    const ids: { id: string }[] = [];
    for (const name of [...new Set(tags)]) {
      const tag = await prisma.tag.upsert({
        where: { slug: slugify(name) },
        update: {},
        create: { name, slug: slugify(name) },
        select: { id: true },
      });
      ids.push(tag);
    }
    tagOp = { set: ids };
  }

  const model = await prisma.model.update({
    where: { id: params.id },
    data: { ...rest, tags: tagOp },
    include: { tags: true, files: true },
  });

  return ok(model);
});

export const DELETE = handler(async (_req: Request, { params }: Ctx) => {
  const model = await prisma.model.findUnique({
    where: { id: params.id },
    select: { id: true },
  });
  if (!model) throw new HttpError('Model not found', 404);

  // Cascades take out files, slice tasks and jobs; then reclaim the disk.
  await prisma.model.delete({ where: { id: params.id } });
  await removeModelTree(params.id);

  return ok({ deleted: params.id });
});
