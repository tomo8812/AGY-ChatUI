export class ArtifactError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, statusCode = 400, details?: Record<string, unknown>) {
    super(message);
    this.name = 'ArtifactError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

export function isArtifactError(err: unknown): err is ArtifactError {
  return err instanceof ArtifactError;
}

export function artifactConflictError(message: string, details?: Record<string, unknown>): ArtifactError {
  return new ArtifactError('ARTIFACT_CONFLICT', message, 409, details);
}

export function unsupportedOperationError(
  operation: string,
  availability: 'unsupported_by_format' | 'disabled_by_resource_tier',
  message: string,
  remediation?: string
): ArtifactError {
  return new ArtifactError('UNSUPPORTED_OPERATION', message, 422, {
    operation,
    availability,
    ...(remediation ? { remediation } : {}),
  });
}
