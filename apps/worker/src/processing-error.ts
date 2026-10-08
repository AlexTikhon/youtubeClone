export class ProcessingError extends Error {
  /**
   * The attempt that produced this error, when it had acquired one. Failure
   * recording is fenced by this identity so an attempt can never fail work it
   * does not own.
   */
  attemptId?: string;

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

/** Another live attempt owns this generation; retry after its lease ends. */
export class AttemptBusyError extends ProcessingError {
  constructor() {
    super(
      'Another processing attempt owns this generation',
      true,
      'Video processing is already in progress',
    );
    this.name = 'AttemptBusyError';
  }
}

/** This attempt lost its lease (or the video) before it could publish. */
export class AttemptOwnershipLostError extends ProcessingError {
  constructor() {
    super(
      'The processing attempt no longer owns this generation',
      false,
      'Video processing was superseded by another attempt',
    );
    this.name = 'AttemptOwnershipLostError';
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
