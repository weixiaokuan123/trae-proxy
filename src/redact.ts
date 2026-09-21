/**
 * 错误信息脱敏：把本机用户目录前缀替换为 `~`，避免日志/界面/截图泄露
 * 真实的 Windows 用户名与目录结构。
 *
 * 只做「路径前缀归一」，保留文件名与其余信息（便于排错），
 * 不改变任何逻辑，纯字符串处理。
 *
 * @module trae-proxy/redact
 */

import { homedir } from 'node:os'

const HOME = homedir()

/**
 * 把文本中的本机 home 目录路径替换为 `~`。
 * 兼容反斜杠/正斜杠两种写法（Windows 大小写不敏感）。
 */
export function redactPaths(text: string): string {
  if (text === '') return text
  let out = text
  // 1) 精确替换 homedir 的两种写法（整体替换，非贪婪）
  for (const p of [HOME, HOME.replace(/\\/g, '/')]) {
    if (p !== '') out = out.split(p).join('~')
  }
  // 2) 兜底：任何 `X:\Users\<name>` / `X:/Users/<name>` 形式
  out = out.replace(/[A-Za-z]:[\\/]Users[\\/][^\\/\s"']+/g, '~')
  return out
}
