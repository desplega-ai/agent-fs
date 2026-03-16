import { Hono } from "hono";
import { generateOpenAPISpec } from "@/core";

export function docsRoutes() {
  const router = new Hono();

  router.get("/openapi.json", (c) => {
    return c.json(generateOpenAPISpec());
  });

  return router;
}
