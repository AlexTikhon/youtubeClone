export class ProcessingError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean,
    public readonly publicReason: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ProcessingError';
  }
}

export function asProcessingError(error: unknown): ProcessingError {
  return error instanceof ProcessingError
    ? error
    : new ProcessingError(
        error instanceof Error ? error.message : String(error),
        true,
        'Video processing failed after multiple attempts',
        { cause: error },
      );
}
