import assert from 'node:assert/strict'
import { test } from 'node:test'
import { REGION_GATEWAYS, regionOfEdition, regionOfHost } from '../src/region.ts'

/**
 * 刷新 host 白名单的行为约定。
 *
 * 这条白名单的唯一目的是「别把 refresh token 发给攻击者指定的地址」，
 * 但它同时有一条**不能碰的红线**：仓库自己会出网访问的每一个官方域名
 * 都必须能通过。误判的代价不是安全告警，而是「国际版 Trae 突然用不了」。
 *
 * 所以这里同时钉住两件事：攻击 host 必拒、真实网关必过。
 */

/** 与 refresh.ts 中 trustedTraeRegion / normalizeHost 同构的判定。 */
function trustedTraeRegion(hostname: string): 'cn' | 'ai' | undefined {
  for (const [region, gateways] of Object.entries(REGION_GATEWAYS)) {
    for (const base of Object.values(gateways)) {
      let h: string
      try { h = new URL(base).hostname } catch { continue }
      if (h === hostname) return region as 'cn' | 'ai'
    }
  }
  return regionOfHost(hostname)
}

function normalizeHost(host: string, edition: 'cn' | 'sg' | 'solo' | 'solo-sg'): string {
  const trimmed = host.trim().replace(/\/$/, '')
  const url = new URL(trimmed)
  if (url.protocol !== 'https:') throw new Error('必须是 https')
  const region = trustedTraeRegion(url.hostname)
  if (region === undefined) throw new Error('不是已知的 Trae 官方域名')
  if (region !== regionOfEdition(edition)) throw new Error('区域与安装版本不符')
  return trimmed
}

test('REGION_GATEWAYS 里每个真实主机都能通过（国际版不能被误伤）', () => {
  for (const [region, gateways] of Object.entries(REGION_GATEWAYS)) {
    const edition = region === 'ai' ? 'solo-sg' : 'solo'
    for (const base of Object.values(gateways)) {
      assert.doesNotThrow(
        () => normalizeHost(base, edition),
        `${region} 的官方网关 ${base} 不应被自己的白名单拒绝`,
      )
    }
  }
})

test('后缀 tricks 一律拒绝（不能用 endsWith 蒙混）', () => {
  for (const bad of [
    'https://evil-api.trae.cn.attacker.tld',
    'https://trae.cn.attacker.tld',
    'https://attacker.tld/api.trae.cn',
    'https://attacker.tld',
  ]) {
    assert.throws(() => normalizeHost(bad, 'solo'), undefined, `${bad} 应被拒绝`)
  }
})

test('非 https 一律拒绝（明文会泄露 refresh token）', () => {
  assert.throws(() => normalizeHost('http://api.trae.cn', 'solo'))
})

test('云元数据与本地地址拒绝（盲 SSRF）', () => {
  for (const bad of ['https://169.254.169.254', 'https://localhost:8080', 'file:///etc/passwd']) {
    assert.throws(() => normalizeHost(bad, 'solo'))
  }
})

test('区域与安装版本不符时拒绝（cn 的凭据不许发往国际网关）', () => {
  assert.throws(() => normalizeHost('https://api.trae.ai', 'solo'))
  assert.throws(() => normalizeHost('https://api.trae.cn', 'solo-sg'))
})

test('非法 URL 拒绝', () => {
  assert.throws(() => normalizeHost('not a url', 'solo'))
})

test('合法 host 回归：尾斜杠、子域、com.cn 别名', () => {
  assert.equal(normalizeHost('https://api.trae.cn', 'solo'), 'https://api.trae.cn')
  assert.equal(normalizeHost('https://api.trae.cn/', 'solo'), 'https://api.trae.cn')
  assert.doesNotThrow(() => normalizeHost('https://api.trae.com.cn', 'solo'))
  assert.doesNotThrow(() => normalizeHost('https://foo.trae.cn', 'solo'))
  assert.doesNotThrow(() => normalizeHost('https://sg-gateway.trae.ai', 'solo-sg'))
})
