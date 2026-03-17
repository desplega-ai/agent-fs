export interface Credential {
  id: string
  name: string
  endpoint: string
  apiKey: string
}

const CREDENTIALS_KEY = "agent-fs-credentials"
const ACTIVE_KEY = "agent-fs-active-credential"

export function getCredentials(): Credential[] {
  try {
    const raw = localStorage.getItem(CREDENTIALS_KEY)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

export function saveCredential(c: Credential): void {
  const existing = getCredentials()
  const idx = existing.findIndex((e) => e.id === c.id)
  if (idx >= 0) {
    existing[idx] = c
  } else {
    existing.push(c)
  }
  localStorage.setItem(CREDENTIALS_KEY, JSON.stringify(existing))
}

export function removeCredential(id: string): void {
  const existing = getCredentials().filter((c) => c.id !== id)
  localStorage.setItem(CREDENTIALS_KEY, JSON.stringify(existing))
  if (getActiveCredentialId() === id) {
    localStorage.removeItem(ACTIVE_KEY)
  }
}

function getActiveCredentialId(): string | null {
  return localStorage.getItem(ACTIVE_KEY)
}

export function getActiveCredential(): Credential | null {
  const id = getActiveCredentialId()
  if (!id) return null
  return getCredentials().find((c) => c.id === id) ?? null
}

export function setActiveCredential(id: string): void {
  localStorage.setItem(ACTIVE_KEY, id)
}
