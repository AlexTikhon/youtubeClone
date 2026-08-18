const LOCAL_SEED_PASSWORD = 'youtube-clone-dev';

export function resolveDevelopmentSeedPassword(
  environment: Pick<NodeJS.ProcessEnv, 'NODE_ENV' | 'DEV_SEED_PASSWORD'>,
): string {
  const configuredPassword = environment.DEV_SEED_PASSWORD;
  if (configuredPassword && configuredPassword.length > 0) {
    return configuredPassword;
  }
  if (
    environment.NODE_ENV === 'development' ||
    environment.NODE_ENV === 'test'
  ) {
    return LOCAL_SEED_PASSWORD;
  }
  throw new Error(
    'DEV_SEED_PASSWORD must be explicitly configured outside development/test',
  );
}
