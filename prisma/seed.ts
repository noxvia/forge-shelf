/**
 * Idempotent seed. Runs on every container start; only fills in what's missing.
 *
 * Slicer profiles used to live here. Slicing now happens in your desktop slicer,
 * so all that remains is a starter set of tags.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const tags = [
  { name: 'Miniature', slug: 'miniature', color: '#f0883e' },
  { name: 'Functional', slug: 'functional', color: '#58a6ff' },
  { name: 'Terrain', slug: 'terrain', color: '#3fb950' },
  { name: 'Cosplay', slug: 'cosplay', color: '#bc8cff' },
  { name: 'Spare part', slug: 'spare-part', color: '#d29922' },
  { name: 'Needs supports', slug: 'needs-supports', color: '#f85149' },
];

async function main() {
  for (const t of tags) {
    await prisma.tag.upsert({ where: { slug: t.slug }, update: {}, create: t });
  }
  const tagCount = await prisma.tag.count();
  console.log(`[seed] ${tagCount} tags`);
}

main()
  .catch((e) => {
    console.error('[seed] failed:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
