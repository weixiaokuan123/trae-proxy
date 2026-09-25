/**
 * Trae 上游请求协议：公共请求头构造与端点拼接。
 *
 * 验证记录见 docs/INTL_SG_EVIDENCE.md §2.3：两个网关接受完全相同的头部形状
 * （x-app-id / 身份头 / Cloud-IDE-JWT），因此不再按 edition 分叉。
 *
 * @module trae-proxy/protocol
 */

import { randomUUID } from 'node:crypto'
import type { TraeCredential } from './auth.ts'
import type { TraeIdentity } from './identity.ts'
import { identityHeaders } from './identity.ts'

export type TraeHeaderProfile = 'agent-task' | 'model-detail' | 'raw-chat' | 'native-curl'

/**
 * Numeric version code sent when the persisted build version is not a plain
 * integer. The upstream binds `x-app-version-code` / `x-ide-version-code` as a
 * number: Trae stores `iCubeLastVersion` as a dotted build string (observed
 * `2.3.76922` on TRAE SOLO CN 0.1.56), which the server rejects with
 * `4001 ... expr_path=app_version_code, cause=parameter type does not match
 * binding data`. Verified 2026-08-29: with a numeric code the same request
 * returns HTTP 200 + `text/event-stream` on
 * `/api/agent/v3/llm_utils_chat` (`solo_work_lite`).
 *
 * Only the *format* of this field is normalised. Machine, device and app
 * version stay exactly as persisted — nothing here impersonates a device.
 */
export const TRAE_VERSION_CODE_FALLBACK = '20260716'

/** Keep a purely numeric build version; fall back when it cannot bind. */
export function normalizeTraeVersionCode(buildVersion: string | undefined): string {
  if (buildVersion === undefined || buildVersion.trim() === '') return TRAE_VERSION_CODE_FALLBACK
  const trimmed = buildVersion.trim()
  return /^\d+$/.test(trimmed) ? trimmed : TRAE_VERSION_CODE_FALLBACK
}

/**
 * Headers shared by every Trae edition. The same shape is accepted by both
 * gateways (verified read-only on the international gateway 2026-09-15,
 * docs/INTL_SG_EVIDENCE.md §2.3: identical `x-app-id`, identity headers, and
 * `Cloud-IDE-JWT` auth), so there is no per-edition branch any more.
 */
export function buildTraeHeaders(
  credential: TraeCredential,
  identity: TraeIdentity,
  options: { appId?: string; requestId?: string; profile?: TraeHeaderProfile } = {},
): Record<string, string> {
  const requestId = options.requestId ?? randomUUID()
  const traceId = requestId.replaceAll('-', '').slice(0, 32)
  const profile = options.profile ?? 'agent-task'
  const common = {
    'Authorization': `Cloud-IDE-JWT ${credential.accessToken}`,
    'X-Ide-Token': credential.accessToken,
    'x-plugin-channel': 'icube-ai',
    'User-Agent': `Trae/${identity.appVersion ?? identity.buildVersion ?? 'unknown'}`,
    'x-app-id': options.appId ?? '6eefa01c-1036-4c7e-9ca5-d891f63bfcd8',
    ...identityHeaders(identity),
    // The upstream binds these as numbers; a dotted build string is rejected.
    'x-app-version-code': normalizeTraeVersionCode(identity.buildVersion),
    'x-ide-version-code': normalizeTraeVersionCode(identity.buildVersion),
    'x-custom-trace-id': traceId,
    'x-flow-traceparent': `04-${traceId}-${traceId.slice(0, 16)}-01`,
    'request-traffic-type': 'prod',
    'Content-Type': 'application/json',
  }
  if (profile === 'native-curl') {
    // Exact set printed by Trae 3.3.83's own get_skill_detail curl diagnostic.
    // No Authorization, plugin channel, User-Agent or speculative bridge headers.
    return {
      'Content-Type': 'application/json',
      'request-traffic-type': 'prod',
      'x-app-id': options.appId ?? '6eefa01c-1036-4c7e-9ca5-d891f63bfcd8',
      ...identityHeaders(identity),
      'x-custom-trace-id': traceId,
      'x-flow-traceparent': `04-${traceId}-${traceId.slice(0, 16)}-01`,
      'X-Ide-Token': credential.accessToken,
    }
  }
  if (profile === 'model-detail') return { ...common, 'Accept': 'application/json' }
  if (profile === 'raw-chat') return { ...common, 'Accept': 'text/event-stream' }
  return {
    ...common,
    'X-Cloudide-Token': credential.accessToken,
    'x-uid': credential.userId,
    'x-request-id': requestId,
    'x-trae-request-id': requestId,
    'Accept': 'text/event-stream',
  }
}

/** Backwards-compatible alias; the headers are no longer CN-specific. */
export const buildTraeCnHeaders = buildTraeHeaders

export function traeEndpoint(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/$/, '')}/${path.replace(/^\//, '')}`
}
