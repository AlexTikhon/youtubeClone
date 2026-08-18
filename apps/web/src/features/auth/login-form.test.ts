import { describe, expect, it } from 'vitest';

import { loginDefaultsForEnvironment } from './login-form';

describe('loginDefaultsForEnvironment', () => {
  it('prefills and explains the local seeded account in development and test', () => {
    expect(loginDefaultsForEnvironment('development')).toEqual({
      email: 'developer@example.test',
      password: 'youtube-clone-dev',
      showDevelopmentCredentials: true,
    });
    expect(loginDefaultsForEnvironment('test')).toEqual({
      email: 'developer@example.test',
      password: 'youtube-clone-dev',
      showDevelopmentCredentials: true,
    });
  });

  it('renders no credential defaults or seeded-account instruction in production', () => {
    expect(loginDefaultsForEnvironment('production')).toEqual({
      email: '',
      password: '',
      showDevelopmentCredentials: false,
    });
  });
});
