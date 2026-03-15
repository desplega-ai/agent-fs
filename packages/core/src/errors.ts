export class AgentFSError extends Error {
  readonly code: string;
  readonly suggestion?: string;

  constructor(code: string, message: string, suggestion?: string) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.suggestion = suggestion;
  }

  toJSON() {
    return {
      error: this.code,
      message: this.message,
      ...(this.suggestion && { suggestion: this.suggestion }),
    };
  }
}

export class NotFoundError extends AgentFSError {
  readonly path?: string;

  constructor(message: string, opts?: { path?: string; suggestion?: string }) {
    super("NOT_FOUND", message, opts?.suggestion);
    this.path = opts?.path;
  }

  toJSON() {
    return {
      ...super.toJSON(),
      ...(this.path && { path: this.path }),
    };
  }
}

export class PermissionDeniedError extends AgentFSError {
  readonly requiredRole?: string;
  readonly yourRole?: string;

  constructor(
    message: string,
    opts?: { requiredRole?: string; yourRole?: string; suggestion?: string }
  ) {
    super("PERMISSION_DENIED", message, opts?.suggestion);
    this.requiredRole = opts?.requiredRole;
    this.yourRole = opts?.yourRole;
  }

  toJSON() {
    return {
      ...super.toJSON(),
      ...(this.requiredRole && { required_role: this.requiredRole }),
      ...(this.yourRole && { your_role: this.yourRole }),
    };
  }
}

export class EditConflictError extends AgentFSError {
  readonly path?: string;

  constructor(message: string, opts?: { path?: string; suggestion?: string }) {
    super("EDIT_CONFLICT", message, opts?.suggestion);
    this.path = opts?.path;
  }

  toJSON() {
    return {
      ...super.toJSON(),
      ...(this.path && { path: this.path }),
    };
  }
}

export class IndexingInProgressError extends AgentFSError {
  readonly path?: string;

  constructor(message: string, opts?: { path?: string; suggestion?: string }) {
    super(
      "INDEXING_IN_PROGRESS",
      message,
      opts?.suggestion ?? "Try again in a moment"
    );
    this.path = opts?.path;
  }

  toJSON() {
    return {
      ...super.toJSON(),
      ...(this.path && { path: this.path }),
    };
  }
}

export class ValidationError extends AgentFSError {
  readonly field?: string;

  constructor(message: string, opts?: { field?: string; suggestion?: string }) {
    super("VALIDATION_ERROR", message, opts?.suggestion);
    this.field = opts?.field;
  }

  toJSON() {
    return {
      ...super.toJSON(),
      ...(this.field && { field: this.field }),
    };
  }
}
