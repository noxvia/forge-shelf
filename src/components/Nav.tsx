'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import clsx from 'clsx';
import { Boxes, Printer, ListChecks, SlidersHorizontal, Activity, Grid3x3 } from 'lucide-react';

const LINKS = [
  { href: '/', label: 'Library', icon: Boxes },
  { href: '/plates', label: 'Plates', icon: Grid3x3 },
  { href: '/printers', label: 'Printers', icon: Printer },
  { href: '/jobs', label: 'Jobs', icon: ListChecks },
  { href: '/profiles', label: 'Profiles', icon: SlidersHorizontal },
  { href: '/system', label: 'System', icon: Activity },
];

export function Nav() {
  const pathname = usePathname();

  return (
    <header className="sticky top-0 z-40 border-b border-edge bg-bg/90 backdrop-blur">
      <div className="mx-auto flex max-w-[1600px] items-center gap-6 px-4 py-3">
        <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight">
          <span className="grid h-7 w-7 place-items-center rounded bg-accent text-bg">
            <Boxes size={16} />
          </span>
          Forge Shelf
        </Link>

        <nav className="flex items-center gap-1">
          {LINKS.map(({ href, label, icon: Icon }) => {
            const active = href === '/' ? pathname === '/' : pathname.startsWith(href);
            return (
              <Link
                key={href}
                href={href}
                className={clsx(
                  'flex items-center gap-1.5 rounded px-3 py-1.5 text-sm transition-colors',
                  active ? 'bg-panel2 text-ink' : 'text-muted hover:text-ink hover:bg-panel',
                )}
              >
                <Icon size={15} />
                {label}
              </Link>
            );
          })}
        </nav>
      </div>
    </header>
  );
}
