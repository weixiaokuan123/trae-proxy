/**
 * trae-proxy 守护入口：一个进程同时服务国内(cn)与国际(ai)两个回环端点。
 *
 * 改自 dingminhua/dsh-connect-trae（MIT，Copyright (c) 2026 LaoDing）。
 * 仅依赖 Node 内置能力，TypeScript 由 Node 22.19+/24 的类型擦除直接运行，无需构建。
 *
 * @module trae-proxy/serve
 */

import { randomBytes } from 'node:crypto'
import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LiveTraeStore, type TraeCredential } from './auth.ts'
import { fromSoloModels, TraeCatalog } from './catalog.ts'
import { resolveTraeIdentity } from './identity.ts'
import { traeStorageCandidates } from './paths.ts'
import { refreshTraeCredential } from './refresh.ts'
import { regionOfCredential, regionOfEdition, type TraeRegion } from './region.ts'
import { createTraeShim, type TraeShim, type ShimLogger } from './shim.ts'
import { TraeSoloBridge } from './solo-bridge.ts'
import { TraeSoloUpstreamClient } from './solo.ts'
import { TraeSigninClient } from './signin.ts'
import { SigninScheduler, formatSec } from './scheduler.ts'

import { redactPaths } from './redact.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)
const KEYS_DIR = join(ROOT, 'keys')
const STATE_DIR = join(ROOT, 'state')

const SIGNIN_ENABLED = (process.env['TRAE_SIGNIN'] ?? 'on') !== 'off'
const SIGNIN_START_HOUR = Number(process.env['TRAE_SIGNIN_START_HOUR'] ?? 7)
const SIGNIN_END_HOUR = Number(process.env['TRAE_SIGNIN_END_HOUR'] ?? 10)
const SIGNIN_TICK_MS = 5 * 60 * 1000
const SIGNIN_INITIAL_DELAY_MS = 60 * 1000

const REGION_PORTS: Record<TraeRegion, number> = {
  cn: Number(process.env['TRAE_CN_PORT'] ?? 39303),
  ai: Number(process.env['TRAE_AI_PORT'] ?? 39304),
}

function ts(): string {
  return new Date().toISOString()
}

/**
 * 日志参数格式化。
 *
 * - 对象不再被 String() 压成 "[object Object]"，改为 JSON，保住诊断信息；
 * - 统一做路径脱敏：日志会追加落盘长期保存，不应写入本机用户名与目录结构。
 */
function fmtLogArgs(args: unknown[]): string {
  const text = args.map((a) => {
    if (typeof a === 'string') return a
    if (a instanceof Error) return `${a.name}: ${a.message}`
    try { return JSON.stringify(a) ?? String(a) } catch { return String(a) }
  }).join(' ')
  return redactPaths(text)
}

/**
 * 日志落盘 + 运行期轮转。
 *
 * 历史上日志由 start.ps1 用 cmd 重定向（node ... >> out.log 2>> err.log），
 * 文件句柄在 cmd 手里 —— 本进程拿不到句柄，**无法在运行期轮转**，只能在重启时
 * 轮一次。后果是「长期不重启的进程，日志无上限增长」。
 *
 * 因此改为：若环境变量指明了日志路径，由本进程直接持有该文件并在超限时自行轮转；
 * 未设置（前台调试）时退回 stdout/stderr。
 *
 * 轮转策略与 start.ps1 里的 Rotate-Log 保持一致：超限改名为 .1，只保留一份。
 */

/** 单个日志文件上限，与 start.ps1 的 Rotate-Log 同一阈值。 */
const LOG_MAX_BYTES = 5 * 1024 * 1024

interface LogSink {
  path: string
  /** 当前文件已有字节数，作为轮转基线。 */
  size: number
}

function makeLogSink(envKey: string): LogSink | null {
  const p = process.env[envKey]
  if (p === undefined || p.trim() === '') return null
  try {
    mkdirSync(dirname(p), { recursive: true })
    // 追加而非截断：既有内容保留，并把当前大小作为轮转基线
    return { path: p, size: statSync(p, { throwIfNoEntry: false })?.size ?? 0 }
  } catch {
    return null // 建不出来就退回 stdout/stderr，不让日志问题拦住启动
  }
}

function writeLogSink(sink: LogSink, text: string): void {
  const bytes = Buffer.byteLength(text)
  if (sink.size + bytes > LOG_MAX_BYTES) {
    try {
      rmSync(`${sink.path}.1`, { force: true })
      renameSync(sink.path, `${sink.path}.1`)
      sink.size = 0
    } catch {
      // 轮转失败就继续往当前文件追加：丢日志比不轮转更糟
    }
  }
  appendFileSync(sink.path, text, 'utf8')
  sink.size += bytes
}

const LOG_OUT = makeLogSink('TRAE_PROXY_LOG_OUT')
const LOG_ERR = makeLogSink('TRAE_PROXY_LOG_ERR')

function writeLog(level: 'info' | 'warn' | 'error', line: string): void {
  const sink = level === 'info' ? LOG_OUT : LOG_ERR
  if (sink !== null) writeLogSink(sink, line)
  else if (level === 'info') process.stdout.write(line)
  else process.stderr.write(line)
}

/** 日志重复抑制窗口：同一 level + 同一文本在该窗口内只输出一次。 */
const LOG_DEDUP_WINDOW_MS = 60_000
let lastLogKey = ''
/** 当前这段「相同日志连发」的起始时刻（不是上一条的时刻，见 shouldSuppressLog）。 */
let runStartedAtMs = 0
let suppressedLogCount = 0

/**
 * 连续重复日志抑制。
 *
 * 上游反复故障时（例如某区域长期未登录），同一条错误会被每个 tick 重记一次，
 * 既刷屏又放大磁盘写入。这里对「同一 level + 同一文本」在窗口内只输出首次。
 *
 * 窗口从**这段连发的第一条**开始算。若像原先那样在每次抑制时把计时基准顺延到
 * 当前时刻，窗口会被无限推迟 —— 同一条错误持续不断且期间没有别的日志时，
 * 「同类日志已抑制 N 条」就永远刷不出来，事后也看不出到底发生过多少次。
 * 现在窗口到期会先落盘计数、再让当前这条正常输出，保证每个窗口至少留一行可见。
 */
function shouldSuppressLog(key: string): { suppress: boolean; flushNote: string | null } {
  const now = Date.now()
  const sameKey = key === lastLogKey
  const windowExpired = now - runStartedAtMs >= LOG_DEDUP_WINDOW_MS

  if (suppressedLogCount > 0 && (!sameKey || windowExpired)) {
    const note = `（同类日志已抑制 ${suppressedLogCount} 条）`
    suppressedLogCount = 0
    lastLogKey = key
    runStartedAtMs = now
    return { suppress: false, flushNote: note }
  }
  if (sameKey && !windowExpired) {
    suppressedLogCount++
    return { suppress: true, flushNote: null }
  }
  lastLogKey = key
  runStartedAtMs = now
  return { suppress: false, flushNote: null }
}

function emitLog(level: 'info' | 'warn' | 'error', args: unknown[]): void {
  const text = fmtLogArgs(args)
  const { suppress, flushNote } = shouldSuppressLog(`${level}:${text}`)
  const at = ts()
  if (flushNote !== null) writeLog(level, `[${at}] [${level}] ${flushNote}\n`)
  if (suppress) return
  writeLog(level, `[${at}] [${level}] ${text}\n`)
}

const logger: ShimLogger = {
  info: (...args) => emitLog('info', args),
  warn: (...args) => emitLog('warn', args),
  error: (...args) => emitLog('error', args),
}


async function loadOrCreateKey(file: string): Promise<string> {
  try {
    const existing = (await readFile(file, 'utf8')).trim()
    if (existing !== '') return existing
  } catch {
    // 不存在则生成
  }
  const key = randomBytes(32).toString('base64url')
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  await writeFile(file, `${key}\n`, { mode: 0o600 })
  return key
}

interface RegionRuntime {
  region: TraeRegion
  store: LiveTraeStore
  solo: TraeSoloUpstreamClient
  catalog: TraeCatalog
  signin: TraeSigninClient
  scheduler: SigninScheduler
}

async function refreshModels(rt: RegionRuntime): Promise<void> {
  try {
    const models = await rt.solo.fetchModels()
    if (models.length > 0) {
      rt.catalog.set(fromSoloModels(models))
      logger.info(`trae(${rt.region}): 模型目录已刷新，共 ${models.length} 个`)
    }
  } catch (error: unknown) {
    logger.warn(`trae(${rt.region}): 模型目录刷新失败，使用内置 fallback（${String(error instanceof Error ? error.message : error)}）`)
  }
}

async function buildRegion(region: TraeRegion): Promise<{ shim: TraeShim; rt: RegionRuntime }> {
  const store = new LiveTraeStore({
    region,
    refresh: async credential => {
      const candidates = traeStorageCandidates().filter(item =>
        item.source === 'desktop' && regionOfEdition(item.edition) === region
        && item.edition === credential.edition)
      let device: { deviceId: string; machineId: string } | undefined
      try {
        const id = await resolveTraeIdentity(candidates.length > 0 ? candidates : traeStorageCandidates(), credential.edition)
        device = { deviceId: id.deviceId, machineId: id.machineId }
      } catch {
        device = undefined
      }
      return refreshTraeCredential(credential, undefined, device)
    },
  })

  const identity = async (credentialArg?: TraeCredential) => {
    // 调用方（solo / signin）通常已经解析过凭据，直接复用，避免同一请求
    // 里 store.resolve() 被调用两次；未传入时才自行解析。
    const credential = credentialArg ?? await store.resolve()
    const candidates = traeStorageCandidates().filter(item =>
      item.source === 'desktop' && regionOfCredential(credential) === regionOfEdition(item.edition)
      && item.edition === credential.edition)
    return resolveTraeIdentity(candidates.length > 0 ? candidates : traeStorageCandidates(), credential.edition)
  }

  const solo = new TraeSoloUpstreamClient({
    credential: () => store.resolve(),
    identity,
    log: (message, detail) => logger.warn(message, detail),
  })

  const catalog = new TraeCatalog(region)
  const bridge = new TraeSoloBridge(solo, catalog)
  const signin = new TraeSigninClient(region, store, identity)
  // 签到状态按区域分文件：cn / ai 各持一份，避免两个调度器各持内存副本
  // 整体回写同一文件时互相覆盖（丢更新）。
  const scheduler = new SigninScheduler({
    stateFile: join(STATE_DIR, `signin-state-${region}.json`),
    startHour: SIGNIN_START_HOUR,
    endHour: SIGNIN_END_HOUR,
    log: m => logger.info(m),
  })
  const rt: RegionRuntime = { region, store, solo, catalog, signin, scheduler }

  const key = await loadOrCreateKey(join(KEYS_DIR, `${region}.key`))
  const shim = createTraeShim({
    region,
    port: REGION_PORTS[region],
    token: key,
    store,
    client: bridge,
    catalog,
    logger,
    signinStatus: SIGNIN_ENABLED ? async () => {
      const entry = await scheduler.entry(region) ?? await scheduler.plan(region)
      let view: unknown = null
      let error: string | undefined
      try { view = await signin.getStatus() }
      catch (e) { error = e instanceof Error ? e.message : String(e) }
      return {
        region,
        scheduledAt: formatSec(entry.runAtSec),
        claimedToday: entry.claimed,
        lastResult: entry.result,
        view,
        ...(error === undefined ? {} : { error }),
      }
    } : undefined,
    signinClaim: SIGNIN_ENABLED ? async () => {
      const outcome = await scheduler.runNow(region, () => signin.claim())
      return { region, ...outcome }
    } : undefined,
    credits: SIGNIN_ENABLED ? async () => {
      if (region !== 'cn') return { region, enabled: false }
      const u = await signin.getUsage()
      return { region, http: u.http, usage: u.body }
    } : undefined,
  })
  return { shim, rt }
}

async function main(): Promise<void> {
  await mkdir(KEYS_DIR, { recursive: true, mode: 0o700 })
  if (SIGNIN_ENABLED) await mkdir(STATE_DIR, { recursive: true, mode: 0o700 })
  const runtimes: RegionRuntime[] = []
  const shims: TraeShim[] = []
  let signinTimer: NodeJS.Timeout | undefined

  for (const region of ['cn', 'ai'] as TraeRegion[]) {
    const built = await buildRegion(region)
    await built.shim.ready
    shims.push(built.shim)
    runtimes.push(built.rt)
    logger.info(`trae(${region}) 已监听 ${built.shim.baseUrl()} (models=${built.rt.catalog.current().length})`)
    if (SIGNIN_ENABLED) {
      const plan = await built.rt.scheduler.plan(region)
      logger.info(`trae(${region}) 今日签到计划 ${formatSec(plan.runAtSec)}`)
    }
    void refreshModels(built.rt)
  }

  const timer = setInterval(() => {
    for (const rt of runtimes) void refreshModels(rt)
  }, 6 * 60 * 60 * 1000)
  timer.unref()

  async function signinTick(): Promise<void> {
    for (const rt of runtimes) {
      try {
        await rt.scheduler.runIfDue(rt.region, () => rt.signin.claim())
      } catch {
        // 未登录/token 失效/国际区不支持：静默跳过
      }
    }
  }
  if (SIGNIN_ENABLED) {
    setTimeout(() => { void signinTick() }, SIGNIN_INITIAL_DELAY_MS).unref()
    signinTimer = setInterval(() => { void signinTick() }, SIGNIN_TICK_MS)
    signinTimer.unref()
    logger.info(`每日签到已启用：本地 ${SIGNIN_START_HOUR}:00–${SIGNIN_END_HOUR}:00 随机时刻自动领取`)
  }

  logger.info(`trae-proxy 就绪：国内 ${REGION_PORTS.cn} / 国际 ${REGION_PORTS.ai}`)

  let closing = false
  const shutdown = async (signal: string): Promise<void> => {
    if (closing) return
    closing = true
    logger.info(`收到 ${signal}，正在关闭...`)
    clearInterval(timer)
    if (signinTimer !== undefined) clearInterval(signinTimer)
    await Promise.allSettled(shims.map(shim => shim.close()))
    process.exit(0)
  }
  process.on('SIGINT', () => { void shutdown('SIGINT') })
  process.on('SIGTERM', () => { void shutdown('SIGTERM') })
}

main().catch((error: unknown) => {
  logger.error('trae-proxy 启动失败：', error)
  process.exit(1)
})
