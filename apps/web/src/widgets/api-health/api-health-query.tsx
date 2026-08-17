'use client';

import { useQuery } from '@tanstack/react-query';

import type { HealthResponse } from '@youtube-clone/types';

import { apiRequest } from '@/shared/api/api-client';
import { queryKeys } from '@/shared/query/query-keys';

import { SystemStatus } from './system-status';

export function ApiHealthQuery() {
  const health = useQuery({
    queryKey: queryKeys.health.api,
    queryFn: () => apiRequest<HealthResponse>('/api/v1/health/ready'),
    refetchInterval: 30_000,
  });
  return (
    <SystemStatus
      state={
        health.isPending
          ? 'checking'
          : health.isSuccess
            ? 'available'
            : 'unavailable'
      }
    />
  );
}
