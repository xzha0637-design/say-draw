// 持久化层(SQLite,better-sqlite3)。隔离模型:
//   user_id(账号)× session_id(一段对话,含场景图与版本检查点),用户间互不可见。
// 图片:Seedream 返回的 URL 会过期,故出图后把字节下载入库(images.bytes BLOB),
//   用「能力 URL」/api/images/:id?k=<access_key> 长期可看可下载,不依赖外链存活。
import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data')
fs.mkdirSync(DATA_DIR, { recursive: true })

const db = new Database(path.join(DATA_DIR, 'saydraw.db'))
db.pragma('journal_mode = WAL')
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL,
    salt TEXT NOT NULL, hash TEXT NOT NULL, created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS tokens (
    token TEXT PRIMARY KEY, user_id TEXT NOT NULL,
    username TEXT NOT NULL, created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, title TEXT NOT NULL,
    history TEXT NOT NULL, scene TEXT, versions TEXT NOT NULL,
    current_index INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS images (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, session_id TEXT,
    access_key TEXT NOT NULL, mime TEXT NOT NULL, bytes BLOB NOT NULL,
    source_url TEXT, prompt TEXT, created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_conv_user ON conversations(user_id);
  CREATE INDEX IF NOT EXISTS idx_img_user ON images(user_id);
  CREATE INDEX IF NOT EXISTS idx_img_session ON images(session_id);
`)

const now = () => Date.now()

// ───────────────────────── 用户与登录令牌 ─────────────────────────

function issueToken(userId, username) {
  const token = crypto.randomBytes(24).toString('hex')
  db.prepare('INSERT INTO tokens(token, user_id, username, created_at) VALUES (?,?,?,?)').run(
    token,
    userId,
    username,
    now(),
  )
  return { token, userId, username }
}

/** 注册并直接登录;用户名重复返回 {ok:false}。密码以 scrypt 加盐哈希存储,不存明文。 */
export function register(username, password) {
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) {
    return { ok: false, reason: '用户名已存在' }
  }
  const id = crypto.randomUUID()
  const salt = crypto.randomBytes(16).toString('hex')
  const hash = crypto.scryptSync(password, salt, 64).toString('hex')
  db.prepare('INSERT INTO users(id, username, salt, hash, created_at) VALUES (?,?,?,?,?)').run(
    id,
    username,
    salt,
    hash,
    now(),
  )
  return { ok: true, ...issueToken(id, username) }
}

export function login(username, password) {
  const u = db.prepare('SELECT * FROM users WHERE username = ?').get(username)
  if (!u) return { ok: false, reason: '用户不存在' }
  const hash = crypto.scryptSync(password, u.salt, 64)
  if (!crypto.timingSafeEqual(hash, Buffer.from(u.hash, 'hex'))) {
    return { ok: false, reason: '密码不正确' }
  }
  return { ok: true, ...issueToken(u.id, username) }
}

/** 校验令牌;有效返回 { userId, username },无效返回 null。 */
export function auth(token) {
  const row = db.prepare('SELECT user_id, username FROM tokens WHERE token = ?').get(token)
  return row ? { userId: row.user_id, username: row.username } : null
}

// ───────────────────────── 会话(对话)CRUD ─────────────────────────

function rowToConv(r) {
  return {
    id: r.id,
    title: r.title,
    history: JSON.parse(r.history),
    scene: r.scene ? JSON.parse(r.scene) : null,
    versions: JSON.parse(r.versions),
    currentIndex: r.current_index,
    updatedAt: r.updated_at,
  }
}

/** 会话列表(摘要,按最近更新排序)。 */
export function listConversations(userId) {
  return db
    .prepare('SELECT id, title, versions, updated_at FROM conversations WHERE user_id = ? ORDER BY updated_at DESC')
    .all(userId)
    .map((r) => ({
      id: r.id,
      title: r.title,
      updatedAt: r.updated_at,
      versionCount: JSON.parse(r.versions).length,
    }))
}

export function createConversation(userId) {
  const conv = {
    id: crypto.randomUUID(),
    title: '新会话',
    history: [],
    scene: null,
    versions: [],
    currentIndex: -1,
    updatedAt: now(),
  }
  db.prepare(
    'INSERT INTO conversations(id, user_id, title, history, scene, versions, current_index, updated_at) VALUES (?,?,?,?,?,?,?,?)',
  ).run(conv.id, userId, conv.title, '[]', null, '[]', -1, conv.updatedAt)
  return conv
}

export function getConversation(userId, sessionId) {
  const r = db.prepare('SELECT * FROM conversations WHERE id = ? AND user_id = ?').get(sessionId, userId)
  return r ? rowToConv(r) : null
}

/** 覆盖保存快照;标题取首条用户发言前 14 字。会话不存在或不属于该用户返回 null。 */
export function saveConversation(userId, sessionId, snapshot) {
  const prev = db.prepare('SELECT title FROM conversations WHERE id = ? AND user_id = ?').get(sessionId, userId)
  if (!prev) return null
  const firstUser = (snapshot.history || []).find((m) => m.role === 'user')
  const title = (firstUser?.content || prev.title || '新会话').slice(0, 14)
  const updatedAt = now()
  db.prepare(
    'UPDATE conversations SET title=?, history=?, scene=?, versions=?, current_index=?, updated_at=? WHERE id=? AND user_id=?',
  ).run(
    title,
    JSON.stringify(snapshot.history || []),
    snapshot.scene ? JSON.stringify(snapshot.scene) : null,
    JSON.stringify(snapshot.versions || []),
    Number.isInteger(snapshot.currentIndex) ? snapshot.currentIndex : -1,
    updatedAt,
    sessionId,
    userId,
  )
  return { title, updatedAt }
}

export function deleteConversation(userId, sessionId) {
  const info = db.prepare('DELETE FROM conversations WHERE id = ? AND user_id = ?').run(sessionId, userId)
  if (info.changes === 0) return false
  db.prepare('DELETE FROM images WHERE session_id = ? AND user_id = ?').run(sessionId, userId) // 连带清理本会话图片
  return true
}

// ───────────────────────── 图片入库与取用 ─────────────────────────

/** 把出图字节入库,返回 { id, accessKey }。accessKey 即「能力」:持有即可看/下载该图。 */
export function saveImage({ userId, sessionId, bytes, mime, sourceUrl, prompt }) {
  const id = crypto.randomUUID()
  const accessKey = crypto.randomBytes(16).toString('hex')
  db.prepare(
    'INSERT INTO images(id, user_id, session_id, access_key, mime, bytes, source_url, prompt, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
  ).run(id, userId, sessionId || null, accessKey, mime, bytes, sourceUrl || null, prompt || null, now())
  return { id, accessKey }
}

/** 供 /api/images 出图:校验 access_key 才返回字节(能力 URL,无需登录头,便于 <img>/下载链接直用)。 */
export function getImageForServe(id, accessKey) {
  const r = db.prepare('SELECT mime, bytes, access_key FROM images WHERE id = ?').get(id)
  if (!r || r.access_key !== accessKey) return null
  return { mime: r.mime, bytes: r.bytes }
}

/** 取某图的原始 Seedream 外链(改图时作参考图传给生图模型);校验归属。 */
export function getImageSource(userId, imageId) {
  const r = db.prepare('SELECT source_url FROM images WHERE id = ? AND user_id = ?').get(imageId, userId)
  return r ? r.source_url : null
}
