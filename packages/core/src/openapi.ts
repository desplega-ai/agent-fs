import { zodToJsonSchema } from "zod-to-json-schema";
import { getRegisteredOps, getOpDefinition } from "./ops/index.js";
import { profileUpdateSchema } from "./identity/users.js";
import { VERSION } from "./version.js";

export function generateOpenAPISpec() {
  const ops = getRegisteredOps();

  // Build per-op request schemas
  const opSchemas: Record<string, object> = {};
  const opDescriptions: Record<string, string> = {};
  for (const name of ops) {
    const def = getOpDefinition(name)!;
    const jsonSchema = zodToJsonSchema(def.schema, { target: "openApi3" });
    // Remove $schema wrapper that zod-to-json-schema adds
    const { $schema, ...schema } = jsonSchema as any;
    opSchemas[name] = schema;
    opDescriptions[name] = def.description;
  }

  // Build the oneOf list for the dispatch endpoint
  const opOneOf = ops.map((name) => ({
    type: "object" as const,
    title: name,
    description: opDescriptions[name],
    required: ["op", ...(((opSchemas[name] as any).required as string[]) || [])],
    properties: {
      op: { type: "string", const: name },
      driveId: { type: "string", description: "Target drive ID (optional, uses default drive)" },
      ...((opSchemas[name] as any).properties || {}),
    },
    additionalProperties: false,
  }));

  return {
    openapi: "3.1.0",
    info: {
      title: "agent-fs API",
      version: VERSION,
      description:
        "A persistent, searchable filesystem for AI agents. agent-fs is to files what agentmail is to email.",
      license: {
        name: "MIT",
        url: "https://github.com/desplega-ai/agent-fs/blob/main/LICENSE",
      },
    },
    servers: [
      {
        url: "http://localhost:7433",
        description: "Local development server",
      },
    ],
    paths: {
      "/health": {
        get: {
          summary: "Health check",
          operationId: "health",
          tags: ["System"],
          security: [],
          responses: {
            "200": {
              description: "Server is healthy",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      ok: { type: "boolean", const: true },
                      version: { type: "string" },
                      maxUploadBytes: {
                        type: "integer",
                        minimum: 1,
                        description: "Maximum raw upload size in bytes",
                      },
                      features: {
                        type: "array",
                        items: { type: "string" },
                        description:
                          "Optional capabilities this server supports (e.g. \"share-links\"). Absent on older servers.",
                      },
                    },
                    required: ["ok", "version", "maxUploadBytes"],
                  },
                },
              },
            },
          },
        },
      },
      "/share/{token}": {
        get: {
          summary: "Public share page",
          description:
            "Unauthenticated HTML preview of a file shared with the share-create op, with a Download button. The token is the only credential. Expired, revoked and used-up links return the same 'link expired' page (404 for an unknown token, 410 otherwise). Each successful page view counts against maxViews.",
          operationId: "sharePage",
          tags: ["Share"],
          security: [],
          parameters: [
            { name: "token", in: "path", required: true, schema: { type: "string", minLength: 43, maxLength: 43 } },
          ],
          responses: {
            "200": { description: "The share page", content: { "text/html": { schema: { type: "string" } } } },
            "302": { description: "The share is a folder (kind \"site\"): redirect to /site/{token}/" },
            "404": { description: "Unknown token or file no longer available", content: { "text/html": { schema: { type: "string" } } } },
            "410": { description: "Link expired, revoked or used up", content: { "text/html": { schema: { type: "string" } } } },
            "429": { description: "Too many requests from this address" },
          },
        },
      },
      "/share/{token}/raw": {
        get: {
          summary: "Inline bytes for a share embed",
          description:
            "Serves (or redirects to a short-lived presigned URL for) the shared file inline. Only images, PDF, audio and video; HTML and SVG are never served inline. Does not count as a view.",
          operationId: "shareRaw",
          tags: ["Share"],
          security: [],
          parameters: [
            { name: "token", in: "path", required: true, schema: { type: "string", minLength: 43, maxLength: 43 } },
          ],
          responses: {
            "200": { description: "File bytes" },
            "302": { description: "Redirect to a short-lived presigned URL" },
            "404": { description: "Not found or not embeddable" },
            "410": { description: "Link expired, revoked or used up" },
          },
        },
      },
      "/share/{token}/download": {
        get: {
          summary: "Download a shared file",
          description:
            "Serves (or redirects to a short-lived presigned URL for) the shared file with Content-Disposition: attachment. Does not count as a view.",
          operationId: "shareDownload",
          tags: ["Share"],
          security: [],
          parameters: [
            { name: "token", in: "path", required: true, schema: { type: "string", minLength: 43, maxLength: 43 } },
          ],
          responses: {
            "200": { description: "File bytes as an attachment" },
            "302": { description: "Redirect to a short-lived presigned URL" },
            "404": { description: "File no longer available" },
            "410": { description: "Link expired, revoked or used up" },
          },
        },
      },
      "/site/{token}/{path}": {
        get: {
          summary: "File of a shared folder (site share)",
          description:
            "Serves a file from a folder shared with the share-create op (kind \"site\"). An empty path or one ending in '/' serves that folder's index.html; a folder named without its trailing slash redirects (301) to the slash form when it has an index.html. `/site/{token}` redirects to `/site/{token}/`. The token is the only credential. Every response is proxied through this server (no presigned redirects) and carries `Content-Security-Policy: sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals; frame-ancestors *` (an opaque origin: no cookies or storage), `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, `Cache-Control: no-store` and `Access-Control-Allow-Origin: *`. Files over 25 MB are refused. Does not count views. `/site/*` has its own per-IP rate limit (`AGENT_FS_SITE_RATE_LIMIT`, default 600/min).",
          operationId: "siteFile",
          tags: ["Share"],
          security: [],
          parameters: [
            { name: "token", in: "path", required: true, schema: { type: "string", minLength: 43, maxLength: 43 } },
            {
              name: "path",
              in: "path",
              required: true,
              description: "Path inside the shared folder; may contain '/'. Empty for index.html.",
              schema: { type: "string" },
            },
          ],
          responses: {
            "200": { description: "File bytes, with the content type of the file name" },
            "301": { description: "Redirect to the folder form with a trailing slash" },
            "400": { description: "Path is not valid inside the folder ('.', '..', NUL, bad encoding)" },
            "404": { description: "Unknown token, not a site share, or no such file" },
            "410": { description: "Link expired or revoked" },
            "413": { description: "File is larger than 25 MB" },
            "429": { description: "Too many requests from this address" },
          },
        },
      },
      "/auth/register": {
        post: {
          summary: "Register a new user",
          operationId: "register",
          tags: ["Auth"],
          security: [],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    email: { type: "string", format: "email" },
                  },
                  required: ["email"],
                },
              },
            },
          },
          responses: {
            "200": {
              description: "User registered",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      userId: { type: "string" },
                      orgId: { type: "string" },
                      driveId: { type: "string" },
                      apiKey: { type: "string" },
                    },
                    required: ["userId", "orgId", "driveId", "apiKey"],
                  },
                },
              },
            },
          },
        },
      },
      "/auth/me": {
        get: {
          summary: "Get current user info",
          operationId: "me",
          tags: ["Auth"],
          responses: {
            "200": {
              description: "Current user",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      id: { type: "string" },
                      email: { type: "string" },
                      createdAt: { type: "string", format: "date-time" },
                    },
                    required: ["id", "email", "createdAt"],
                  },
                },
              },
            },
          },
        },
      },
      "/auth/profile": {
        get: {
          summary: "Get your own profile",
          operationId: "getProfile",
          tags: ["Auth"],
          responses: {
            "200": { description: "Authenticated user's profile", content: {
              "application/json": { schema: { type: "object", required: ["userId", "email", "displayName"], properties: {
                userId: { type: "string" }, email: { type: "string" }, displayName: { type: ["string", "null"] },
              } } },
            } },
            "401": { description: "Unauthorized" },
          },
        },
        patch: {
          summary: "Update your own display name",
          description: "Names are trimmed and limited to 1–100 characters. Send null to clear. No target user ID is accepted.",
          operationId: "updateProfile",
          tags: ["Auth"],
          requestBody: { required: true, content: {
            "application/json": { schema: zodToJsonSchema(profileUpdateSchema, { target: "openApi3" }) },
          } },
          responses: {
            "200": { description: "Updated profile (same shape as GET /auth/profile)" },
            "400": { description: "Invalid profile fields" },
            "401": { description: "Unauthorized" },
          },
        },
      },
      "/auth/reset-key": {
        post: {
          summary: "Reset your own API key",
          description:
            "Rotates the caller's API key. The old key stops working immediately. Records an api_key_reset audit event.",
          operationId: "resetApiKey",
          tags: ["Auth"],
          responses: {
            "200": {
              description: "API key reset",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      apiKey: { type: "string" },
                    },
                    required: ["apiKey"],
                  },
                },
              },
            },
            "401": {
              description: "Unauthorized",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Error" },
                },
              },
            },
          },
        },
      },
      "/orgs/{orgId}/members/{userId}/reset-key": {
        post: {
          summary: "Reset a member's API key (org admin only)",
          description:
            "Org admins can rotate a member's API key on their behalf, e.g. to recover a locked-out user. The old key stops working immediately. Records an api_key_reset audit event with the admin as actor.",
          operationId: "resetMemberApiKey",
          tags: ["Auth"],
          parameters: [
            {
              name: "orgId",
              in: "path",
              required: true,
              schema: { type: "string" },
              description: "Organization ID",
            },
            {
              name: "userId",
              in: "path",
              required: true,
              schema: { type: "string" },
              description: "ID of the member whose key to reset",
            },
          ],
          responses: {
            "200": {
              description: "Member's API key reset",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      apiKey: { type: "string" },
                      userId: { type: "string" },
                      email: { type: "string" },
                    },
                    required: ["apiKey", "userId", "email"],
                  },
                },
              },
            },
            "401": {
              description: "Unauthorized",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Error" },
                },
              },
            },
            "403": {
              description: "Caller is not an org admin",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Error" },
                },
              },
            },
            "404": {
              description: "Org not found, or userId is not a member of the org",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Error" },
                },
              },
            },
          },
        },
      },
      "/orgs/{orgId}/drives/{driveId}/events": {
        get: {
          summary: "Stream drive changes",
          operationId: "watchDrive",
          tags: ["Drives"],
          description:
            "Drive members can stream committed changes with Bearer authentication. The first event is ready. Heartbeat comments (: ping) arrive every 5 seconds. Each user can open at most 8 concurrent streams. Events are live only, with no replay.",
          parameters: [
            { name: "orgId", in: "path", required: true, schema: { type: "string" } },
            { name: "driveId", in: "path", required: true, schema: { type: "string" } },
          ],
          responses: {
            "200": {
              description: "SSE frames use event: <name> and data: <JSON>, followed by a blank line.",
              content: { "text/event-stream": {
                schema: { type: "string" },
                example: 'event: ready\ndata: {"driveId":"drive-id","at":"2026-09-30T12:00:00.000Z"}\n\n: ping\n\n',
              } },
              "x-sse-events": {
                ready: {
                  type: "object",
                  required: ["driveId", "at"],
                  properties: { driveId: { type: "string" }, at: { type: "string", format: "date-time" } },
                },
                "file.changed": {
                  type: "object",
                  required: ["type", "driveId", "path", "version", "operation", "actor", "at"],
                  properties: {
                    type: { type: "string", const: "file.changed" },
                    driveId: { type: "string" },
                    path: { type: "string" },
                    version: { type: "integer", minimum: 1 },
                    operation: { type: "string", enum: ["write", "edit", "append", "delete", "revert"] },
                    actor: { type: "string", description: "User ID of the actor" },
                    at: { type: "string", format: "date-time" },
                  },
                },
                "comment.changed": {
                  type: "object",
                  required: ["type", "driveId", "path", "commentId", "parentId", "action", "actor", "at"],
                  properties: {
                    type: { type: "string", const: "comment.changed" },
                    driveId: { type: "string" },
                    path: { type: "string" },
                    commentId: { type: "string" },
                    parentId: { type: ["string", "null"] },
                    action: { type: "string", enum: ["created", "updated", "resolved", "reopened", "deleted"] },
                    actor: { type: "string", description: "User ID of the actor" },
                    at: { type: "string", format: "date-time" },
                  },
                },
              },
            },
            "401": { description: "Missing or invalid Bearer key" },
            "404": { description: "Drive not found or the user is not a member" },
            "429": { description: "Concurrent stream cap or request rate limit exceeded" },
          },
        },
      },
      "/orgs/{orgId}/ops": {
        post: {
          summary: "Dispatch a file operation",
          operationId: "dispatchOp",
          tags: ["Operations"],
          description:
            "All file operations go through this single endpoint. The `op` field determines which operation to execute.",
          parameters: [
            {
              name: "orgId",
              in: "path",
              required: true,
              schema: { type: "string" },
              description: "Organization ID",
            },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  oneOf: opOneOf,
                  discriminator: {
                    propertyName: "op",
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Operation result (varies by op)",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    description:
                      "Response shape depends on the operation. See each op's description for details.",
                  },
                },
              },
            },
            "400": {
              description: "Validation error",
              content: {
                "application/json": {
                  schema: {
                    $ref: "#/components/schemas/Error",
                  },
                },
              },
            },
            "401": {
              description: "Unauthorized",
              content: {
                "application/json": {
                  schema: {
                    $ref: "#/components/schemas/Error",
                  },
                },
              },
            },
            "403": {
              description: "Permission denied (RBAC)",
              content: {
                "application/json": {
                  schema: {
                    $ref: "#/components/schemas/Error",
                  },
                },
              },
            },
            "404": {
              description: "File or resource not found",
              content: {
                "application/json": {
                  schema: {
                    $ref: "#/components/schemas/Error",
                  },
                },
              },
            },
          },
        },
      },
    },
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          description: "API key obtained from /auth/register",
        },
      },
      schemas: {
        Error: {
          type: "object",
          properties: {
            error: { type: "string" },
            message: { type: "string" },
          },
          required: ["error", "message"],
        },
      },
    },
    security: [{ bearerAuth: [] }],
  };
}
