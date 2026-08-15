import { useQuery } from '@tanstack/react-query';
import type { AuthenticatedUserResponse } from '@youtube-clone/types';
import { apiRequest } from '@/shared/api/api-client';

export function useCurrentUser() {
  return useQuery({
    queryKey: ['auth', 'me'],
    queryFn: () => apiRequest<AuthenticatedUserResponse>('/api/v1/auth/me'),
    retry: false,
  });
}
