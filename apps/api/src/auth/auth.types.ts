export interface AuthenticatedUser {
  id: string;
  email: string;
  username: string;
  channel: {
    id: string;
    name: string;
    handle: string;
  };
}
