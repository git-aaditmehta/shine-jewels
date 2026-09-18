import type { Role } from './types'

export type ApiSession = { token: string; user: { id: string; role: Role; organizationId: string; displayName?: string }; offlineAuthorizationExpiresAt: string }
export type RequestOptions = { method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'; token?: string; body?: unknown }

const baseUrl = import.meta.env.VITE_API_BASE_URL?.replace(/\/$/, '') ?? 'https://shine-jewels-api.aaditmehta45.workers.dev'

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? 'GET',
    headers: { accept: 'application/json', ...(options.body ? { 'content-type': 'application/json' } : {}), ...(options.token ? { authorization: `Bearer ${options.token}` } : {}) },
    body: options.body ? JSON.stringify(options.body) : undefined
  })
  const payload = await response.json().catch(() => ({ error: 'The server returned an invalid response.' })) as T & { error?: string }
  if (!response.ok) throw new Error(payload.error ?? `Request failed with status ${response.status}.`)
  return payload
}

export function login(input: { organizationId: string; username: string; password: string; deviceId: string; deviceName: string }) {
  return api<ApiSession>('/auth/login', { method: 'POST', body: input })
}

export const workerApiBaseUrl = baseUrl
export const workerApi=<T>(path:string,options:RequestOptions={})=>api<T>(path,options)
