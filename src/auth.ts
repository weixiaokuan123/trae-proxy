/**
 * 精简版 Trae 凭据解析（独立 OpenAI 兼容代理用）。
 *
 * 改自 dingminhua/dsh-connect-trae/src/auth.ts（MIT，Copyright (c) 2026 LaoDing）。
 *
 * 相对原版的刻意简化：
 *  - 只读“当前桌面登录态”（各 edition 的 storage.json，或 CN CLI 明文 JWT），
 *    不再维护插件自有副本、不做多账号持久选择；
 *  - 每次调用都重新读盘+解密，外部在 Trae 里切换账号后下一次请求自动跟随；
 *  - token 刷新结果只保存在进程内存，绝不写回桌面 storage.json，也不落地副本；
 *  - 去掉 @deepseek-ai/dsh-home-paths 与 @deepseek-ai/dsh-atomic-write。
 *
 * @module trae-proxy/auth
 */

import { readFile, stat } from 'node:fs/promises'
import { traeStorageCandidates, type TraeEdition, type TraeStorageCandidate } from './paths.ts'
import { parseTraeCliToken, parseTraeStorageDocument } from './decrypt.ts'
import { regionOfCredential, regionOfEdition, type TraeRegion } from './region.ts'
import type { TraeRefreshOutcome } from './refresh.ts'

import { redactPaths } from './redact.ts'

/** 文件 stat 签名：mtimeMs+size。文件未变则签名稳定，切号/续期后变化。 */
async function statSigOf(filePath: string): Promise<string> {
  const s = await stat(filePath)
  return `${s.mtimeMs}:${s.size}`
}

export interface TraeCredential {
  accessToken: string
  refreshToken?: string
  userId: string
  accountName?: string
  host: string
  userRegion?: string
  expiresAtMs: number
  refreshExpiresAtMs?: number
  edition: TraeEdition
  source: 'desktop' | 'cli'
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function timeToMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value > 1e12 ? value : value * 1000
  if (typeof value !== 'string' || value.trim() === '') return undefined
  const numeric = Number(value)
  if (Number.isFinite(numeric) && numeric > 0) return numeric > 1e12 ? numeric : numeric * 1000
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function userRegionOf(value: unknown): string | undefined {
  const raw = typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)['region']
    : value
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : undefined
}

const CLI_DEFAULT_HOST = 'https://api.trae.cn'

export function normalizeTraeCredential(
  raw: unknown,
  edition: TraeEdition,
  source: TraeCredential['source'],
): TraeCredential | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const value = raw as Record<string, unknown>
  const accessToken = optionalString(value['token']) ?? optionalString(value['accessToken'])
  if (accessToken === undefined) return undefined
  const expiresAtMs = timeToMs(value['expiredAt'] ?? value['expiresAt']) ?? 0
  const refreshExpiresAtMs = timeToMs(value['refreshExpiredAt'] ?? value['refreshExpiresAt'])
  const refreshToken = optionalString(value['refreshToken'])
  const userRegion = userRegionOf(value['userRegion'])
  const account = typeof value['account'] === 'object' && value['account'] !== null && !Array.isArray(value['account'])
    ? value['account'] as Record<string, unknown>
    : undefined
  const accountName = optionalString(account?.['username'])
  return {
    accessToken,
    ...refreshToken === undefined ? {} : { refreshToken },
    userId: optionalString(value['userId']) ?? '',
    ...accountName === undefined ? {} : { accountName },
    host: optionalString(value['host']) ?? '',
    ...userRegion === undefined ? {} : { userRegion },
    expiresAtMs,
    ...refreshExpiresAtMs === undefined ? {} : { refreshExpiresAtMs },
    edition,
    source,
  }
}

function isENOENT(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as { code?: unknown }).code === 'ENOENT'
}

export interface LiveTraeStoreOptions {
  region: TraeRegion
  /** 显式 storage.json 路径（或 CLI token 文件），优先于自动探测。 */
  storagePath?: string
  /** 上游 token 刷新函数。 */
  refresh: (credential: TraeCredential) => Promise<TraeRefreshOutcome>
  refreshMarginMs?: number
}

export interface TraeStatus {
  state: 'signed-in' | 'signed-out'
  region: TraeRegion
  account?: string
  edition?: TraeEdition
  host?: string
  filePath?: string
  expiresAtMs?: number
  message?: string
}

/**
 * 单区域、当前登录态的凭据 store。每次 resolve() 重新读盘解密，
 * 因此在 Trae 内切换账号后无需重启即可跟随。刷新结果仅存内存。
 */
export class LiveTraeStore {
  private readonly region: TraeRegion
  private readonly storagePathOverride?: string
  private readonly refresh: (credential: TraeCredential) => Promise<TraeRefreshOutcome>
  private readonly refreshMarginMs: number
  private mem: { key: string; credential: TraeCredential } | undefined
  private inflight: Promise<TraeCredential> | undefined
  /**
   * 凭据文件的 stat 签名（mtimeMs+size）。命中且未到刷新阈值时，
   * 直接复用内存凭据，跳过「读整个 storage.json + AES 解密」，
   * 避免高频对话时反复解密。文件被切号/续期改写后 stat 变化，自动失效重读。
   */
  private statSig: string | undefined

  constructor(options: LiveTraeStoreOptions) {
    this.region = options.region
    this.storagePathOverride = options.storagePath
    this.refresh = options.refresh
    this.refreshMarginMs = options.refreshMarginMs ?? 5 * 60_000
  }

  /** 该区域的候选文件（desktop + CN CLI）。 */
  private candidates(): TraeStorageCandidate[] {
    if (this.storagePathOverride !== undefined) {
      const edition: TraeEdition = this.region === 'ai' ? 'solo-sg' : 'solo'
      return [
        { edition, path: this.storagePathOverride, source: 'desktop' },
        { edition, path: this.storagePathOverride, source: 'cli' },
      ]
    }
    return traeStorageCandidates().filter(candidate =>
      regionOfEdition(candidate.edition) === this.region
      && (candidate.source === 'desktop' || regionOfEdition(candidate.edition) === 'cn'))
  }

  livePath(): string {
    return this.candidates()[0]?.path ?? '(no candidate)'
  }

  private async credentialFrom(candidate: TraeStorageCandidate): Promise<TraeCredential | undefined> {
    const text = await readFile(candidate.path, 'utf8')
    if (candidate.source === 'cli') {
      if (regionOfEdition(candidate.edition) !== 'cn') return undefined
      const claims = parseTraeCliToken(text)
      return normalizeTraeCredential({
        token: claims.accessToken,
        userId: claims.userId,
        host: CLI_DEFAULT_HOST,
        expiredAt: claims.expiresAtMs,
      }, candidate.edition, 'cli')
    }
    const doc = parseTraeStorageDocument(text)
    return normalizeTraeCredential(doc, candidate.edition, 'desktop')
  }

  /** 读取当前区域第一个可用凭据（文件缺失/解密失败自动跳过）。 */
  private async readCurrent(): Promise<{ credential: TraeCredential; candidate: TraeStorageCandidate } | undefined> {
    for (const candidate of this.candidates()) {
      try {
        const credential = await this.credentialFrom(candidate)
        if (credential === undefined) continue
        if (regionOfCredential(credential) !== this.region) continue
        return { credential, candidate }
      } catch (error: unknown) {
        if (isENOENT(error)) continue
        // 文件存在但解密/解析失败：继续尝试下一个候选
      }
    }
    return undefined
  }

  async resolve(): Promise<TraeCredential> {
    // 快速路径：凭据文件 stat 未变且内存有效（未到刷新阈值）→ 直接复用，
    // 跳过 readFile + AES 解密。stat 是轻量元数据调用，开销远低于解密。
    if (this.mem !== undefined) {
      const currentSig = await this.liveStatSig().catch(() => undefined)
      if (currentSig !== undefined && currentSig === this.statSig
        && this.mem.credential.expiresAtMs > Date.now() + this.refreshMarginMs) {
        return this.mem.credential
      }
    }

    const live = await this.readCurrent()
    if (live === undefined) {
      throw new Error(`trae(${this.region}): 未找到可用登录态（${this.candidates().map(c => c.path).join(' 或 ')}）`)
    }
    const c = live.credential
    const key = `${c.edition}|${c.source}|${c.expiresAtMs}|${c.accessToken.slice(0, 32)}`
    if (this.mem?.key === key) {
      if (c.expiresAtMs > Date.now() + this.refreshMarginMs) return this.mem.credential
    } else {
      this.mem = { key, credential: c }
      this.inflight = undefined
    }
    // 记录本次凭据来源文件的 stat 签名，供下一次快速路径使用
    this.statSig = await statSigOf(live.candidate.path).catch(() => this.statSig)
    if (this.mem.credential.expiresAtMs > Date.now() + this.refreshMarginMs) return this.mem.credential

    this.inflight ??= this.refreshNow(this.mem.credential)
      .finally(() => { this.inflight = undefined })
    return this.inflight
  }

  /** 当前 live 候选文件的 stat 签名（取第一个存在的候选）。 */
  private async liveStatSig(): Promise<string | undefined> {
    for (const candidate of this.candidates()) {
      const sig = await statSigOf(candidate.path).catch(() => undefined)
      if (sig !== undefined) return sig
    }
    return undefined
  }

  private async refreshNow(credential: TraeCredential): Promise<TraeCredential> {
    if (credential.refreshToken === undefined
      || (credential.refreshExpiresAtMs !== undefined && credential.refreshExpiresAtMs <= Date.now())) {
      if (credential.expiresAtMs > Date.now() + 30_000) return credential
      throw new Error('trae: access token 已过期且无有效 refresh token，请重新登录 Trae')
    }
    try {
      const outcome = await this.refresh(credential)
      const refreshed: TraeCredential = {
        ...credential,
        accessToken: outcome.accessToken,
        ...outcome.refreshToken === undefined ? {} : { refreshToken: outcome.refreshToken },
        expiresAtMs: outcome.expiresAtMs,
        ...outcome.refreshExpiresAtMs === undefined ? {} : { refreshExpiresAtMs: outcome.refreshExpiresAtMs },
      }
      if (this.mem !== undefined) this.mem = { key: this.mem.key, credential: refreshed }
      return refreshed
    } catch (error: unknown) {
      if (credential.expiresAtMs > Date.now() + 30_000) return credential
      throw new Error(`trae: token 刷新失败且 access token 已过期（${String(error)}）；请重新登录 Trae`)
    }
  }

  async status(): Promise<TraeStatus> {
    const live = await this.readCurrent()
    if (live === undefined) {
      return { state: 'signed-out', region: this.region, filePath: redactPaths(this.livePath()) }
    }
    return {
      state: 'signed-in',
      region: this.region,
      account: live.credential.accountName ?? live.credential.userId,
      edition: live.credential.edition,
      ...live.credential.host === '' ? {} : { host: live.credential.host },
      filePath: redactPaths(live.candidate.path),
      expiresAtMs: live.credential.expiresAtMs,
    }
  }
}
