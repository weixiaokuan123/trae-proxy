/**
 * Trae 上游客户端的最小接口与错误分类：chat 结果要么是成功响应，要么带着
 * 已分类的 kind 与消息失败，供回环层映射为 HTTP 状态码。
 *
 * @module trae-proxy/upstream
 */

export type TraeUpstreamErrorKind =
  | 'authentication'
  | 'hard_credit'
  | 'soft_rate'
  | 'not_found'
  | 'server'
  | 'client'
  | 'unconfigured'

export type TraeChatResult =
  | { ok: true; response: Response }
  | { ok: false; status: number; kind: TraeUpstreamErrorKind; message: string }

export interface TraeUpstreamClient {
  chatStream(bodyJson: string, signal?: AbortSignal): Promise<TraeChatResult>
}
