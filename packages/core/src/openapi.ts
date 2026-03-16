import { zodToJsonSchema } from "zod-to-json-schema";
import { getRegisteredOps, getOpDefinition } from "./ops/index.js";
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
                    },
                    required: ["ok", "version"],
                  },
                },
              },
            },
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
