import { useQuery } from '@tanstack/react-query';
import type { AuthenticatedUserResponse } from '@youtube-clone/types';
import { apiRequest } from '@/shared/api/api-client';
import { queryKeys } from './query-keys';

export function useCurrentUser() {
  return useQuery({
    queryKey: queryKeys.auth,
    queryFn: () => apiRequest<AuthenticatedUserResponse>('/api/v1/auth/me'),
    retry: false,
  });
}
