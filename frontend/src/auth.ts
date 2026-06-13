// 登录态客户端:令牌存 localStorage,所有受保护接口经 authedFetch 自动带上 Authorization。
const TOKEN_KEY = 'saydraw-token'
const NAME_KEY = 'saydraw-username'

let onUnauthorized: (() => void) | null = null
/** 注册令牌失效(401)时的回调,由 main 接管(清登录态、回到登录页)。 */
export function setUnauthorizedHandler(fn: () => void): void {
  onUnauthorized = fn
}

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY)
}
export function getUsername(): string | null {
  return localStorage.getItem(NAME_KEY)
}
function setSession(token: string, username: string): void {
  localStorage.setItem(TOKEN_KEY, token)
  localStorage.setItem(NAME_KEY, username)
}
export function clearSession(): void {
  localStorage.removeItem(TOKEN_KEY)
  localStorage.removeItem(NAME_KEY)
}

type AuthResult = { ok: true; username: string } | { ok: false; reason: string }

async function postAuth(path: string, username: string, password: string): Promise<AuthResult> {
  try {
    const resp = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    })
    const data = await resp.json()
    if (!resp.ok || !data?.ok) return { ok: false, reason: data?.reason || '请求失败' }
    setSession(data.token, data.username)
    return { ok: true, username: data.username }
  } catch {
    return { ok: false, reason: '连不上后端,请确认后端已启动' }
  }
}

export function register(username: string, password: string): Promise<AuthResult> {
  return postAuth('/api/auth/register', username, password)
}
export function login(username: string, password: string): Promise<AuthResult> {
  return postAuth('/api/auth/login', username, password)
}

/** 带令牌的 fetch;遇 401 触发失效回调。 */
export async function authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  const token = getToken()
  if (token) headers.set('Authorization', `Bearer ${token}`)
  const resp = await fetch(path, { ...init, headers })
  if (resp.status === 401) {
    clearSession()
    onUnauthorized?.()
  }
  return resp
}
