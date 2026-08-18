const APPLICATION_ORIGIN = 'https://youtube-clone.invalid';
const ENCODED_BACKSLASH_OR_CONTROL = /%(?:0[0-9a-f]|1[0-9a-f]|5c|7f)/i;

export function safeInternalRedirect(
  candidate: string | undefined,
  fallback = '/',
): string {
  if (
    !candidate?.startsWith('/') ||
    candidate.startsWith('//') ||
    candidate.includes('\\') ||
    hasControlCharacter(candidate) ||
    ENCODED_BACKSLASH_OR_CONTROL.test(candidate)
  ) {
    return fallback;
  }

  try {
    const destination = new URL(candidate, APPLICATION_ORIGIN);
    return destination.origin === APPLICATION_ORIGIN ? candidate : fallback;
  } catch {
    return fallback;
  }
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0)!;
    return codePoint <= 31 || codePoint === 127;
  });
}
