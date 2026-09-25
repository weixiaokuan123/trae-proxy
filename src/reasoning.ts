/**
 * Trae reasoning effort 能力解析：从模型目录条目里读出可用的 effort 取值，
 * 供上层把用户选择映射到 wire 取值。
 *
 * @module trae-proxy/reasoning
 */

export const TRAE_REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh'] as const
export type TraeReasoningEffort = typeof TRAE_REASONING_EFFORTS[number]

export interface TraeReasoningCapability {
  supported: readonly TraeReasoningEffort[]
  defaultEffort?: TraeReasoningEffort
}

export function parseReasoningCapability(value: unknown): TraeReasoningCapability | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const rawOptions = Array.isArray(record['reasoning_effort_options']) ? record['reasoning_effort_options'] : []
  const supported = rawOptions.filter((item): item is TraeReasoningEffort =>
    typeof item === 'string' && (TRAE_REASONING_EFFORTS as readonly string[]).includes(item))
  const rawDefault = record['default_reasoning_effort']
  const defaultEffort = typeof rawDefault === 'string' && supported.includes(rawDefault as TraeReasoningEffort)
    ? rawDefault as TraeReasoningEffort
    : undefined
  if (supported.length === 0 && defaultEffort === undefined) return undefined
  return { supported, ...defaultEffort === undefined ? {} : { defaultEffort } }
}
