/**
 * trae-proxy 版本号。采用语义化版本（semver），用于：
 *  - 启动日志
 *  - /healthz 返回的 version 字段（供自动更新检测比对）
 * 每次发布需手动递增：BUG修复 +PATCH，新功能 +MINOR，不兼容改动 +MAJOR。
 */
export const TRAE_CONNECT_VERSION = '1.1.0'
