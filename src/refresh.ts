/**
 * Trae token 刷新：用 refresh token 换新的 access token。
 *
 * 刷新端点是唯一「按 edition 分叉」的契约：桌面版（CN / 国际）与 SOLO CN 走
 * `/cloudide/...` 路径 + 共享 ClientID，TRAE SOLO 国际版走较新的
 * `/trae/api/v3/oauth/` 路径 + 独立 ClientID 与 DeviceInfo 请求体。
 * 请求始终挂在凭据自带的 host 上，绝不写死 base。
 *
 * @module trae-proxy/refresh
 */

import type { TraeCredential, TraeRefreshOutcome } from './auth.ts'
import type { TraeEdition } from './paths.ts'
import { hostname } from 'node:os'
import { REGION_GATEWAYS, regionOfEdition, regionOfHost, type TraeRegion } from './region.ts'

/**
 * Per-edition refresh contract (docs/INTL_SG_EVIDENCE.md §2.2).
 *
 * The refresh endpoint is the ONE contract that forks by edition rather than
 * by region: the desktop apps (CN and international) plus SOLO CN all use the
 * `/cloudide/...` path and the shared ClientID, while TRAE SOLO international
 * was verified (2026-09-15, official app's own call) on the newer
 * `/trae/api/v3/oauth/` path with its own ClientID and a DeviceInfo body.
 * Every request hangs off the credential's own host, never a hardcoded base.
 */
interface TraeRefreshContract {
  readonly path: string
  readonly clientId: string
  /** Whether the official client sends a DeviceInfo object in the body. */
  readonly deviceInfo: boolean
}

const REFRESH_CONTRACT: Readonly<Record<TraeEdition, TraeRefreshContract>> = {
  cn: { path: '/cloudide/api/v3/trae/oauth/ExchangeToken', clientId: 'ono9krqynydwx5', deviceInfo: false },
  sg: { path: '/cloudide/api/v3/trae/oauth/ExchangeToken', clientId: 'ono9krqynydwx5', deviceInfo: false },
  solo: { path: '/cloudide/api/v3/trae/oauth/ExchangeToken', clientId: 'ono9krqynydwx5', deviceInfo: false },
  'solo-sg': { path: '/trae/api/v3/oauth/ExchangeToken', clientId: 'en1oxy7wnw8j9n', deviceInfo: true },
}

/** Stable device identity for the DeviceInfo body, sourced from the app's own storage. */
export interface TraeRefreshDevice {
  deviceId: string
  machineId: string
}

/**
 * 判定某个主机名是不是本仓库认可、且属于哪个区域的 Trae 官方域名。
 *
 * 两个来源，缺一不可：
 *
 * 1. `REGION_GATEWAYS` 里**本仓库自己就会出网访问**的确切主机名。
 *    这一条是为了覆盖 `trae-api-cn.mchost.guru`、`coresg-normal.trae.ai`
 *    这类分片——它们是 `.mchost.guru` / 具体子域，只靠后缀规则会被误判，
 *    而误判的代价是**国际版 token 刷新直接失败**（用户会突然用不了 Trae）。
 *    既然这些域名本来就写在代码里、其它请求也照样往那儿发，把它们一并
 *    列为可信，既堵住了「任意 host」又不误伤真实路径。
 * 2. `regionOfHost` 的后缀规则（`*.trae.ai` / `*.trae.cn` / `*.trae.com.cn`）。
 *
 * 注意这里用的是**精确相等**而不是 `endsWith`：`evil-api.trae.cn.attacker.tld`
 * 这种后缀 tricks 必须被拒。
 */
function trustedTraeRegion(hostname: string): TraeRegion | undefined {
  for (const [region, gateways] of Object.entries(REGION_GATEWAYS)) {
    for (const base of Object.values(gateways)) {
      let h: string
      try { h = new URL(base).hostname } catch { continue }
      if (h === hostname) return region as TraeRegion
    }
  }
  return regionOfHost(hostname)
}

/**
 * 归一化刷新 host，并**强制校验它确实是 Trae 官方域名**。
 *
 * 「请求挂在凭据自带的 host 上」这条设计在其他地方是优点（多区域共用一份代码），
 * 但这里是全仓库**唯一一处带长期凭据出网、且 host 完全由数据驱动**的调用：
 * body 里带 refresh token，而 host 来自桌面端 storage.json。
 *
 * 为什么必须校验（三个理由都是实测过的，不是理论风险）：
 *
 * 1. `decrypt.ts` 允许明文 JSON（`startsWith('{')` 分支跳过 AES 与完整性校验），
 *    所以同用户写文件即可改写 host，不需要任何密钥。
 * 2. 区域闸门拦不住：`regionOfHost` 对非法域名返回 undefined，
 *    `regionOfCredential` 会一路回退到 `regionOfEdition(edition)`，
 *    而 edition 由「命中哪个候选文件」决定，与 host 无关 → 闸门照样通过。
 * 3. 其余三个仓库的上游 host 全是硬编码或白名单（workbuddy 的 `globalBase`、
 *    trae 的 `REGION_GATEWAYS`、minimax 的 `REGIONS`），只有这里例外。
 */
function normalizeHost(host: string, edition: TraeEdition): string {
  const value = host.trim()
  if (value === '') throw new Error('Trae 刷新 host 缺失')
  const trimmed = value.replace(/\/$/, '')
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw new Error('Trae 刷新 host 不是合法 URL，已拒绝')
  }
  // 必须显式 https：明文 http 会把 refresh token 送到可被嗅探的链路上。
  if (url.protocol !== 'https:') throw new Error('Trae 刷新 host 必须是 https，已拒绝')
  const region = trustedTraeRegion(url.hostname)
  if (region === undefined) throw new Error('Trae 刷新 host 不是已知的 Trae 官方域名，已拒绝')
  const expected = regionOfEdition(edition)
  if (region !== expected) {
    throw new Error(`Trae 刷新 host 区域与安装版本不符（${region} ≠ ${expected}），已拒绝`)
  }
  return trimmed
}

/**
 * Exchange a refresh token for a fresh access token, following the calling
 * edition's verified contract. `device` is only used by editions whose
 * official client sends a DeviceInfo body; when it cannot be resolved the
 * field is omitted rather than sent empty.
 */
export async function refreshTraeCredential(
  credential: TraeCredential,
  signal?: AbortSignal,
  device?: TraeRefreshDevice,
): Promise<TraeRefreshOutcome> {
  const contract = REFRESH_CONTRACT[credential.edition]
  if (contract === undefined) throw new Error(`Trae ${credential.edition} 的刷新契约尚未验证`)
  if (credential.refreshToken === undefined) throw new Error('Trae refresh token 缺失')
  const body: Record<string, unknown> = {
    ClientID: contract.clientId,
    ClientSecret: '-',
    RefreshToken: credential.refreshToken,
    UserID: credential.userId,
  }
  if (contract.deviceInfo && device !== undefined) {
    body['DeviceInfo'] = {
      DeviceID: device.deviceId,
      MachineID: device.machineId,
      PlatformCode: credential.edition === 'solo-sg' ? 'SOLO_PC' : 'TRAE',
      DeviceType: 'PC',
      DeviceName: hostname(),
    }
  }
  const response = await fetch(`${normalizeHost(credential.host, credential.edition)}${contract.path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: signal ?? AbortSignal.timeout(30_000),
  })
  if (!response.ok) throw new Error(`Trae token 刷新失败（HTTP ${response.status}）`)
  const payload = await response.json() as { Result?: Record<string, unknown> }
  const result = payload.Result
  const accessToken = typeof result?.['Token'] === 'string' ? result['Token'] : ''
  if (accessToken === '') throw new Error('Trae token 刷新未返回 token')
  const expiry = result?.['TokenExpireAt']
  const expiresAtMs = typeof expiry === 'number' ? expiry : typeof expiry === 'string' ? Date.parse(expiry) : Number.NaN
  if (!Number.isFinite(expiresAtMs)) throw new Error('Trae token 刷新返回了无效的过期时间')
  const refreshToken = typeof result?.['RefreshToken'] === 'string' && result['RefreshToken'] !== '' ? result['RefreshToken'] : undefined
  return { accessToken, ...refreshToken === undefined ? {} : { refreshToken }, expiresAtMs }
}
