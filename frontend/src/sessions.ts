// 会话(对话)的服务端 API:每个会话 = 一段独立对话,含场景图与版本检查点,按用户隔离。
import { authedFetch } from './auth'
import type { Snapshot } from './chat'

export interface SessionMeta {
  id: string
  title: string
  updatedAt: number
  versionCount: number
}
export interface FullConversation extends Snapshot {
  id: string
  title: string
}

export async function listSessions(): Promise<SessionMeta[]> {
  const r = await authedFetch('/api/conversations')
  const d = await r.json()
  return d?.ok ? d.conversations : []
}

export async function createSession(): Promise<FullConversation | null> {
  const r = await authedFetch('/api/conversations', { method: 'POST' })
  const d = await r.json()
  return d?.ok ? d.conversation : null
}

export async function loadSession(id: string): Promise<FullConversation | null> {
  const r = await authedFetch(`/api/conversations/${id}`)
  const d = await r.json()
  return d?.ok ? d.conversation : null
}

export async function saveSession(id: string, snapshot: Snapshot): Promise<void> {
  await authedFetch(`/api/conversations/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(snapshot),
  })
}

export async function deleteSession(id: string): Promise<boolean> {
  const r = await authedFetch(`/api/conversations/${id}`, { method: 'DELETE' })
  const d = await r.json()
  return d?.ok === true
}
