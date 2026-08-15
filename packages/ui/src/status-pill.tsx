import type { ReactNode } from 'react';

export interface StatusPillProps {
  children: ReactNode;
  tone?: 'neutral' | 'healthy' | 'warning';
}

const toneClasses: Record<NonNullable<StatusPillProps['tone']>, string> = {
  neutral: 'bg-zinc-800 text-zinc-200',
  healthy: 'bg-emerald-950 text-emerald-300 ring-1 ring-emerald-800',
  warning: 'bg-amber-950 text-amber-200 ring-1 ring-amber-800',
};

export function StatusPill({ children, tone = 'neutral' }: StatusPillProps) {
  return (
    <span
      className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${toneClasses[tone]}`}
    >
      {children}
    </span>
  );
}
