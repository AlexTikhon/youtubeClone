import { StatusPill } from '@youtube-clone/ui';

export interface SystemStatusProps {
  state: 'checking' | 'available' | 'unavailable';
}

export function SystemStatus({ state }: SystemStatusProps) {
  if (state === 'checking') return <StatusPill>Checking API</StatusPill>;
  if (state === 'available')
    return <StatusPill tone="healthy">API ready</StatusPill>;
  return <StatusPill tone="warning">API unavailable</StatusPill>;
}
