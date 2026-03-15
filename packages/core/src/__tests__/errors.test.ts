import { describe, test, expect } from "bun:test";
import {
  AgentFSError,
  NotFoundError,
  PermissionDeniedError,
  EditConflictError,
  IndexingInProgressError,
  ValidationError,
} from "../errors.js";

describe("AgentFSError", () => {
  test("sets code, message, and suggestion", () => {
    const err = new AgentFSError("TEST_CODE", "test message", "try again");
    expect(err.code).toBe("TEST_CODE");
    expect(err.message).toBe("test message");
    expect(err.suggestion).toBe("try again");
    expect(err.name).toBe("AgentFSError");
  });

  test("toJSON includes code and message", () => {
    const err = new AgentFSError("CODE", "msg", "hint");
    expect(err.toJSON()).toEqual({
      error: "CODE",
      message: "msg",
      suggestion: "hint",
    });
  });

  test("toJSON omits suggestion when not provided", () => {
    const err = new AgentFSError("CODE", "msg");
    const json = err.toJSON();
    expect(json.suggestion).toBeUndefined();
    expect(json).toEqual({ error: "CODE", message: "msg" });
  });

  test("instanceof Error", () => {
    const err = new AgentFSError("CODE", "msg");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(AgentFSError);
  });
});

describe("NotFoundError", () => {
  test("has NOT_FOUND code", () => {
    const err = new NotFoundError("file missing");
    expect(err.code).toBe("NOT_FOUND");
    expect(err.name).toBe("NotFoundError");
  });

  test("toJSON includes path when provided", () => {
    const err = new NotFoundError("not found", { path: "/foo.txt" });
    const json = err.toJSON();
    expect(json.path).toBe("/foo.txt");
    expect(json.error).toBe("NOT_FOUND");
  });

  test("toJSON omits path when not provided", () => {
    const err = new NotFoundError("not found");
    expect(err.toJSON().path).toBeUndefined();
  });

  test("instanceof chain", () => {
    const err = new NotFoundError("nope");
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err).toBeInstanceOf(AgentFSError);
    expect(err).toBeInstanceOf(Error);
  });
});

describe("PermissionDeniedError", () => {
  test("has PERMISSION_DENIED code", () => {
    const err = new PermissionDeniedError("denied");
    expect(err.code).toBe("PERMISSION_DENIED");
  });

  test("toJSON includes roles", () => {
    const err = new PermissionDeniedError("denied", {
      requiredRole: "editor",
      yourRole: "viewer",
    });
    const json = err.toJSON();
    expect(json.required_role).toBe("editor");
    expect(json.your_role).toBe("viewer");
  });

  test("toJSON omits roles when not provided", () => {
    const err = new PermissionDeniedError("denied");
    const json = err.toJSON();
    expect(json.required_role).toBeUndefined();
    expect(json.your_role).toBeUndefined();
  });
});

describe("EditConflictError", () => {
  test("has EDIT_CONFLICT code", () => {
    const err = new EditConflictError("conflict");
    expect(err.code).toBe("EDIT_CONFLICT");
  });

  test("toJSON includes path", () => {
    const err = new EditConflictError("conflict", { path: "/a.txt" });
    expect(err.toJSON().path).toBe("/a.txt");
  });
});

describe("IndexingInProgressError", () => {
  test("has INDEXING_IN_PROGRESS code", () => {
    const err = new IndexingInProgressError("busy");
    expect(err.code).toBe("INDEXING_IN_PROGRESS");
  });

  test("has default suggestion", () => {
    const err = new IndexingInProgressError("busy");
    expect(err.suggestion).toBe("Try again in a moment");
  });

  test("custom suggestion overrides default", () => {
    const err = new IndexingInProgressError("busy", { suggestion: "wait 5s" });
    expect(err.suggestion).toBe("wait 5s");
  });
});

describe("ValidationError", () => {
  test("has VALIDATION_ERROR code", () => {
    const err = new ValidationError("bad input");
    expect(err.code).toBe("VALIDATION_ERROR");
  });

  test("toJSON includes field", () => {
    const err = new ValidationError("too long", { field: "content" });
    expect(err.toJSON().field).toBe("content");
  });

  test("toJSON omits field when not provided", () => {
    const err = new ValidationError("bad");
    expect(err.toJSON().field).toBeUndefined();
  });
});
