export type AppEnv = {
  Variables: {
    user: { id: string; email: string };
    /** Id of the API key that authenticated the request (`primary` for the legacy key). */
    apiKeyId: string;
    /** Org an org-scoped key is limited to; null for an unscoped key. */
    scopeOrgId: string | null;
  };
};
