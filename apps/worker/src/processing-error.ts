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

/**
 * The attempt's lease ran out while it still was the recorded owner (a stalled
 * heartbeat, an unreachable database, or a slow publication). Nobody superseded
 * it, so unlike ownership loss this is a retryable interruption.
 */
export class AttemptLeaseExpiredError extends ProcessingError {
  constructor() {
    super(
      'The processing attempt lease expired before the work completed',
      true,
      'Video processing was interrupted',
    );
    this.name = 'AttemptLeaseExpiredError';
  }
}

/** The attempt reached its hard time limit and its work was cancelled. */
export class AttemptDeadlineError extends ProcessingError {
  constructor() {
    super(
      'The processing attempt exceeded its maximum duration',
      true,
      'Video processing timed out',
    );
    this.name = 'AttemptDeadlineError';
  }
}

/** The worker is shutting down and cancelled this attempt's work. */
export class WorkerShutdownError extends ProcessingError {
  constructor() {
    super(
      'The worker is shutting down; the processing attempt was cancelled',
      true,
      'Video processing was interrupted by a worker restart',
    );
    this.name = 'WorkerShutdownError';
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
