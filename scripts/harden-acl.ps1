# harden-acl.ps1 —— 收紧本仓库 keys/ 与 state/ 的 Windows ACL。
#
# 目标：目录只对「当前用户 + SYSTEM + Administrators」可读，且**不再继承父目录**，
# 避免权限随父目录扩散到其他主体。
#
# 为什么需要这个脚本（而不是只靠代码里的 mode: 0o600）：
#   Windows 上 Node 的 mode 参数基本无效，文件权限实际来自**目录继承**，
#   而父目录默认给 SYSTEM/Administrators/当前用户三方完全控制。
#   所以「密钥仅本人可读」这件事必须在目录层显式做。
#
# 为什么每次 start.ps1 都跑：
#   主要是覆盖**新装机器**的场景：首次启动时 keys/ 与 state/ 尚不存在，
#   本脚本会跳过；是 node 随后把它们建出来的（继承父目录的宽 ACL），
#   所以 start.ps1 在端口就绪之后还会再调一次，那时目录才存在。
#   另有防御纵深：若有人手工拷贝文件进来把权限放宽，下次启动会被纠正回来。
#   两次调用都幂等，开销可忽略（实测 icacls 约 20–40ms）。
#
# 【已排除的顾虑】曾怀疑「Node 的 mkdir 会重设已存在目录的 DACL、从而抵消收紧」。
#   严格测定后确认**不成立**：Node v24 下 5 个变体（sync/async、
#   recursive 开关、带/不带 mode）对已存在目录执行 mkdir，ACL 均无任何变化。
#   所以代码里的 mkdir 保持原样，不必也不应为此改动 src/serve.ts。
#   （最初的错误结论来自一次失败的 icacls /restore：测试目录其实没被收紧，
#     新文件自然继承到父目录的宽权限，被误读成「收紧被抵消」。）
#
# 【重要】不要把它优化成 icacls 的 /save 搭配 /restore 用法：
#   在本机（Azure AD 账户 + 中等完整性级别）实测 /restore 会失败并报
#   「不能授予调用者未持有的特权」，且**静默不生效**（退出码 1 但仍打印
#   成功信息）。逐个排除过 BOM、路径、SID 解析等因素：
#   同一个 SID 用 /grant:r 是成功的，说明 SID 本身没问题，就是 /restore 不可用。
#   因此这里只用 /inheritance:r + /grant:r，它们在本机验证有效。
#
# 本文件必须带 UTF-8 BOM：Windows PowerShell 5.1 读取无 BOM 的 .ps1 时按 ANSI
# （本机为 GBK）解码，中文注释会被打乱，其中若含反引号或「反斜杠+美元符」，
#   还会因转义吞掉换行，报出与实际位置无关的语法错误（实测踩过两次）。
#   改完本文件请确认前 3 字节为 EF BB BF。
#
# 失败不致命：只 Write-Warning，绝不 exit 1 —— ACL 收紧失败不应该导致代理起不来。

param(
  # 本仓库根目录（默认取脚本的上一级）
  [string]$Root = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = 'Stop'

# 用 SID 而不是名称：本机是中文 Windows，组名可能被本地化。
# 保留 SYSTEM(S-1-5-18) 与 Administrators(S-1-5-32-544) 是为了备份/杀软类工具仍能工作；
# 去掉继承是为了让权限只在本目录范围内生效，不向外扩散。
$SystemSid  = '*S-1-5-18'
$AdminSid   = '*S-1-5-32-544'
# 注意：必须用 ${env:USERNAME} 花括号形式。若写成「美元符 + env:USERDOMAIN + 反斜杠 + 美元符 + env:USERNAME」，
# PowerShell 会把反斜杠后的「\ + 美元符」当成转义的美元符，第二个变量不会被展开，
# 且双引号直到该行结尾都不闭合 —— 报错是「Missing closing '}'」，极难定位（实测踩过）。
$CurrentSid = "${env:USERDOMAIN}\${env:USERNAME}"

function Harden-Dir {
  param([string]$Path)

  if (-not (Test-Path $Path)) {
    # 目录还不存在（代理尚未首次启动）：跳过，等它创建后下次启动再收紧。
    return
  }

  # /inheritance:r  移除所有继承来的 ACE（只保留本目录显式设置的）
  # /grant:r       替换该主体的既有 ACE（而不是追加），保证重复执行结果一致
  # 注意：多个 grant 必须放进一个数组参数传。逐个写成位置参数在
  # PowerShell 5.1 下会解析失败（实测报 Unexpected token）。
  $grants = @(
    "${CurrentSid}:(OI)(CI)(F)",
    "${SystemSid}:(OI)(CI)(F)",
    "${AdminSid}:(OI)(CI)(F)"
  )
  $out = & icacls "$Path" /inheritance:r /grant:r $grants 2>&1

  if ($LASTEXITCODE -ne 0) {
    Write-Warning "harden-acl: 收紧 $Path 失败（退出码 $LASTEXITCODE）：$out"
  }
}

foreach ($name in @('keys', 'state')) {
  Harden-Dir (Join-Path $Root $name)
}