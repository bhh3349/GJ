#!/usr/bin/env bash
#
# 出口代理一键部署 —— Ubuntu 直装 gost（单二进制 + systemd），**不用 Docker**。
#
# 为什么是 HTTP CONNECT 而不是 SOCKS5：
#   网关侧是 Node 原生 fetch（undici），按请求注入 dispatcher 走 HTTP 代理是原生支持的；
#   SOCKS5 得换掉 fetch 栈，与「stream 透传不缓冲」冲突。
#   见 docs/proposals/egress-proxy-onboarding.md §1.1。
#
# 为什么必须带认证 + 来源白名单（本脚本的两条硬约束）：
#   无认证的开放代理会在数小时内被扫描器抓走当免费出口。一旦有别人的流量从这个 IP 出去，
#   「这个出口的额度 = 我们的额度」这个前提当场破掉 —— S4 标定与 §14 自动同步同时失真。
#   所以：脚本**不允许**免认证启动，且**要求**至少一条 --allow。这不是加固项，是「独享」的维护成本。
#
# 幂等：重复执行不重置口令（除非显式 --rotate），不重复写 systemd 单元，不重复下二进制。
#
# 用法：
#   sudo GOST_SHA256=<官方 release 摘要> ./install.sh --allow 203.0.113.7/32
#
# 30 秒自检（在**项目服务器**上跑，不是在这台 VPS 上）：
#   curl -x http://<用户>:<口令>@<本机公网IP>:<端口> -s https://api.ipify.org; echo
#   回显本机公网 IP = 通了。脚本结束时会把这条命令原样打出来。
#
# 退出码：0 = 装好且端口已按白名单放行；3 = 装好但防火墙未确认（需人工，见 SUMMARY）；
#         1 = 失败；2 = 用法/前置条件不满足。
#
set -euo pipefail

# ---------- 默认值 ----------
PORT=8080
SOCKS5_PORT=""            # 默认不开：SOCKS5 不是接线路径，多开一个端口 = 多一份暴露面
PROXY_USER="sub2api"
GOST_VERSION="v3.0.0"     # 以 https://github.com/go-gost/gost/releases 为准，可 --version 覆盖
AUTH_FILE="/etc/sub2api/egress-proxy.env"
UNIT_PATH="/etc/systemd/system/egress-proxy.service"
BIN_PATH="/usr/local/bin/gost"
SERVICE_NAME="egress-proxy"
SERVICE_USER="egress-proxy"
EGRESS_ECHO_URL="${EGRESS_ECHO_URL:-https://api.ipify.org}"
ALLOW=()
ROTATE=0
ENABLE_FIREWALL=0
NO_FIREWALL=0
DRY_RUN=0
FORCE_OS=0
UNINSTALL=0
PURGE=0

log()  { printf '%s\n' "$*"; }
warn() { printf 'WARN  %s\n' "$*" >&2; }
die()  { printf 'FAIL  %s\n' "$*" >&2; exit 1; }
usage_err() { printf 'FAIL  %s\n\n' "$*" >&2; usage >&2; exit 2; }

usage() {
  cat <<'USAGE'
用法：
  sudo GOST_SHA256=<摘要> ./install.sh --allow <CIDR> [--allow <CIDR> ...] [选项]

必填：
  --allow <CIDR>        放行该来源访问代理端口，可重复。至少一条（唯一例外：--uninstall）
                        例：--allow 203.0.113.7/32（项目服务器的公网出口 IP）

选项：
  --port <N>            代理端口，默认 8080
  --user <NAME>         代理认证用户名，默认 sub2api
  --version <vX.Y.Z>    gost 版本，默认 v3.0.0（以官方 release 页为准）
  --socks5-port <N>     额外开一个 SOCKS5 端口（备用；不是网关的接线路径）
  --rotate              重新生成口令（会作废旧口令，需同步更新后台里的出口条目）
  --enable-firewall     显式允许脚本执行 `ufw enable`（默认不 enable，避免把人关在门外）
  --no-firewall         完全不碰 ufw
  --dry-run             只打印将要做什么，不改系统
  --force-os            非 Ubuntu 也继续（脚本按 Ubuntu 写）
  --uninstall           停止并移除服务与凭据文件
  --purge               配合 --uninstall：连 gost 二进制一起删
  -h, --help            本帮助

环境变量：
  GOST_SHA256           gost 发布包的 sha256。**缺失即拒绝下载安装**（不许无校验装二进制）。
                        取摘要：curl -fsSL -o /tmp/gost.tar.gz <包地址> && sha256sum /tmp/gost.tar.gz
  EGRESS_ECHO_URL       自检用的回显 IP 端点，默认 https://api.ipify.org
USAGE
}

# ---------- 参数解析 ----------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --allow)           [[ $# -ge 2 ]] || usage_err "--allow 需要一个 CIDR"; ALLOW+=("$2"); shift 2 ;;
    --port)            [[ $# -ge 2 ]] || usage_err "--port 需要一个端口"; PORT="$2"; shift 2 ;;
    --user)            [[ $# -ge 2 ]] || usage_err "--user 需要一个用户名"; PROXY_USER="$2"; shift 2 ;;
    --version)         [[ $# -ge 2 ]] || usage_err "--version 需要一个版本号"; GOST_VERSION="$2"; shift 2 ;;
    --socks5-port)     [[ $# -ge 2 ]] || usage_err "--socks5-port 需要一个端口"; SOCKS5_PORT="$2"; shift 2 ;;
    --rotate)          ROTATE=1; shift ;;
    --enable-firewall) ENABLE_FIREWALL=1; shift ;;
    --no-firewall)     NO_FIREWALL=1; shift ;;
    --dry-run)         DRY_RUN=1; shift ;;
    --force-os)        FORCE_OS=1; shift ;;
    --uninstall)       UNINSTALL=1; shift ;;
    --purge)           PURGE=1; shift ;;
    -h|--help)         usage; exit 0 ;;
    *)                 usage_err "未知参数：$1" ;;
  esac
done

# 用法校验放在 root 检查之前：参数写错不该先要 sudo 才看得出来（顺带让这几条分支可离线自测）
if [[ $NO_FIREWALL -eq 1 && $ENABLE_FIREWALL -eq 1 ]]; then
  usage_err "--no-firewall 与 --enable-firewall 互斥"
fi
if [[ $UNINSTALL -eq 0 && ${#ALLOW[@]} -eq 0 ]]; then
  usage_err "至少给一条 --allow <CIDR>：没有白名单的代理等于把出口 IP 送人"
fi

[[ ${EUID} -eq 0 ]] || die "需要 root：sudo $0 ..."
command -v curl >/dev/null || die "缺少 curl：apt-get install -y curl"
command -v tar  >/dev/null || die "缺少 tar：apt-get install -y tar"

# ---------- 执行包装（--dry-run 只打印） ----------
run()      { if [[ $DRY_RUN -eq 1 ]]; then printf '  [dry-run] %s\n' "$*"; else "$@"; fi; }
write_file() { # write_file <路径> <权限> <<'EOF' ...
  local path="$1" mode="$2" body
  body="$(cat)"
  if [[ $DRY_RUN -eq 1 ]]; then
    # dry-run 要把**内容**打出来，不能只报行数：这个脚本会写 systemd 单元，
    # 「ExecStart 长什么样」正是上线前最该先看一眼的东西
    printf '  [dry-run] 写 %s（%s）：\n' "$path" "$mode"
    printf '%s\n' "$body" | sed 's/^/    | /'
  else
    umask 077
    printf '%s\n' "$body" > "$path"
    chmod "$mode" "$path"
  fi
}

# ---------- 发行版 / 架构 ----------
if [[ -r /etc/os-release ]]; then
  # shellcheck disable=SC1091
  . /etc/os-release
else
  die "读不到 /etc/os-release，无法确认发行版"
fi
if [[ "${ID:-unknown}" != "ubuntu" && $FORCE_OS -ne 1 ]]; then
  die "检测到发行版 ${ID:-unknown}，本脚本按 Ubuntu 写（Bo 拍）。确认要继续请加 --force-os"
fi

case "$(uname -m)" in
  x86_64)          ARCH="amd64" ;;
  aarch64|arm64)   ARCH="arm64" ;;
  *)               die "不支持的架构：$(uname -m)（只放 amd64 / arm64，其余请手装）" ;;
esac

# ---------- 卸载分支 ----------
if [[ $UNINSTALL -eq 1 ]]; then
  log "== 卸载 ${SERVICE_NAME} =="
  run systemctl disable --now "$SERVICE_NAME" 2>/dev/null || true
  run rm -f "$UNIT_PATH"
  run systemctl daemon-reload
  run rm -f "$AUTH_FILE"
  log "  已移除：$UNIT_PATH / $AUTH_FILE"
  if [[ $PURGE -eq 1 ]]; then
    run rm -f "$BIN_PATH"
    log "  已移除：$BIN_PATH"
  else
    log "  保留二进制：$BIN_PATH（要一起删加 --purge）"
  fi
  log "  注意：ufw 里那几条 allow 规则不会自动删 —— 手工核对 \`ufw status numbered\`"
  exit 0
fi

# ---------- 凭据：已存在则复用，改口令必须显式 ----------
CREDS_NEW=0
if [[ -f "$AUTH_FILE" && $ROTATE -eq 0 ]]; then
  # shellcheck disable=SC1090
  . "$AUTH_FILE"
  EXISTING_USER="${EGRESS_PROXY_USER:-}"
  EXISTING_PASS="${EGRESS_PROXY_PASS:-}"
  if [[ -n "$EXISTING_USER" && -n "$EXISTING_PASS" ]]; then
    PROXY_USER="$EXISTING_USER"
    PROXY_PASS="$EXISTING_PASS"
    log "== 复用已有口令（$AUTH_FILE）；要换口令请显式 --rotate =="
  else
    CREDS_NEW=1
  fi
else
  CREDS_NEW=1
fi

if [[ $CREDS_NEW -eq 1 ]]; then
  # 32 位 hex：字符集只有 [0-9a-f]，既够强又天然避开 URL / systemd / shell 的转义坑
  PROXY_PASS="$(openssl rand -hex 16 2>/dev/null || head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  [[ ${#PROXY_PASS} -ge 32 ]] || die "口令生成失败（openssl / /dev/urandom 都不可用）"
  log "== 生成新口令（128 位随机，仅本机 $AUTH_FILE 保存，明文不进仓库、不进聊天） =="
fi

# ---------- 二进制：无摘要不装 ----------
NEED_DOWNLOAD=1
if [[ -x "$BIN_PATH" && -z "${GOST_SHA256:-}" ]]; then
  NEED_DOWNLOAD=0
  warn "$BIN_PATH 已存在且未给 GOST_SHA256 ⇒ 复用现有二进制，不重新下载"
fi

if [[ $NEED_DOWNLOAD -eq 1 ]]; then
  [[ -n "${GOST_SHA256:-}" ]] || die "缺少 GOST_SHA256，拒绝安装未经校验的二进制。
  取摘要（在能上网的机器上跑，或先下载再拷进来）：
    curl -fsSL -o /tmp/gost.tar.gz https://github.com/go-gost/gost/releases/download/${GOST_VERSION}/gost_${GOST_VERSION#v}_linux_${ARCH}.tar.gz
    sha256sum /tmp/gost.tar.gz
  然后：sudo GOST_SHA256=<上面那串> $0 --allow <CIDR>"

  PKG_URL="https://github.com/go-gost/gost/releases/download/${GOST_VERSION}/gost_${GOST_VERSION#v}_linux_${ARCH}.tar.gz"
  log "== 下载 gost ${GOST_VERSION} (linux/${ARCH}) 并校验 sha256 =="
  TMP_DIR="$(mktemp -d)"
  trap 'rm -rf "${TMP_DIR:-}"' EXIT
  run curl -fsSL --retry 3 --connect-timeout 15 -o "$TMP_DIR/gost.tar.gz" "$PKG_URL"
  if [[ $DRY_RUN -eq 0 ]]; then
    printf '%s  %s\n' "$GOST_SHA256" "$TMP_DIR/gost.tar.gz" | sha256sum -c - \
      || die "sha256 不匹配 ⇒ 包可能被篡改或版本号与摘要不是同一份，已中止（临时文件已清理）"
    tar -xzf "$TMP_DIR/gost.tar.gz" -C "$TMP_DIR" gost
    install -m 0755 "$TMP_DIR/gost" "$BIN_PATH"
  fi
  log "  已安装：$BIN_PATH"
fi

# ---------- 服务账户（无登录、无家目录） ----------
if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
  log "== 建系统用户 $SERVICE_USER（nologin，无家目录） =="
  run useradd --system --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"
fi

# ---------- 凭据文件（root 600） ----------
run install -d -m 0750 -o root -g root /etc/sub2api
write_file "$AUTH_FILE" 600 <<EOF
# 出口代理认证凭据 —— root 可读，本文件**不入仓库**、不进聊天、不进日志。
# 后台「出口管理」里新建出口时，把 user/pass 填进表单（密文落库，见 egress_proxies.secret）。
EGRESS_PROXY_USER=$PROXY_USER
EGRESS_PROXY_PASS=$PROXY_PASS
EGRESS_PROXY_PORT=$PORT
EOF
log "== 凭据写入 $AUTH_FILE（chmod 600 root:root） =="

# ---------- systemd 单元 ----------
# 单元里只放 ${变量名}，真值走 EnvironmentFile —— 口令不落单元文件，也就不会被 `systemctl cat` 打出来
LISTEN_ARGS="-L \"http://\${EGRESS_PROXY_USER}:\${EGRESS_PROXY_PASS}@:\${EGRESS_PROXY_PORT}\""
if [[ -n "$SOCKS5_PORT" ]]; then
  LISTEN_ARGS="${LISTEN_ARGS} -L \"socks5://\${EGRESS_PROXY_USER}:\${EGRESS_PROXY_PASS}@:${SOCKS5_PORT}\""
fi

write_file "$UNIT_PATH" 644 <<UNIT
[Unit]
Description=sub2api egress proxy (HTTP CONNECT, authenticated, source-IP allowlisted)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_USER}
EnvironmentFile=${AUTH_FILE}
ExecStart=${BIN_PATH} ${LISTEN_ARGS}

Restart=always
RestartSec=2

# 加固：不需要任何 capability（监听 >1024 端口），能碰的只有自己的临时目录
NoNewPrivileges=yes
CapabilityBoundingSet=
AmbientCapabilities=
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictAddressFamilies=AF_INET AF_INET6
RestrictNamespaces=yes
RestrictSUIDSGID=yes
LockPersonality=yes
SystemCallFilter=@system-service

[Install]
WantedBy=multi-user.target
UNIT

log "== 写 systemd 单元 $UNIT_PATH =="
run systemctl daemon-reload
run systemctl enable --now "$SERVICE_NAME"

# ---------- 启动验证（不信任 enable 的返回码） ----------
SERVICE_OK=0
if [[ $DRY_RUN -eq 0 ]]; then
  for _ in $(seq 1 20); do
    if systemctl is-active --quiet "$SERVICE_NAME"; then SERVICE_OK=1; break; fi
    sleep 0.5
  done
  if [[ $SERVICE_OK -ne 1 ]]; then
    warn "服务未起来。先看日志：journalctl -u ${SERVICE_NAME} -n 50 --no-pager"
    warn "若日志指向沙箱加固（SystemCallFilter / ProtectSystem），把 $UNIT_PATH 里对应那行注释掉再 daemon-reload"
    die "安装中止：服务未运行"
  fi
fi

# ---------- 本机连通性（证明代理在听；证明出口 IP 要回项目服务器跑） ----------
LOCAL_IP=""
PROXY_IP=""
if [[ $DRY_RUN -eq 0 ]]; then
  LOCAL_IP="$(curl -fsS --max-time 10 "$EGRESS_ECHO_URL" 2>/dev/null || true)"
  PROXY_IP="$(curl -fsS --max-time 10 -x "http://${PROXY_USER}:${PROXY_PASS}@127.0.0.1:${PORT}" "$EGRESS_ECHO_URL" 2>/dev/null || true)"
  if [[ -z "$PROXY_IP" ]]; then
    warn "经 127.0.0.1:${PORT} 自检失败。检查：systemctl status ${SERVICE_NAME} / ss -lntp | grep ${PORT}"
  else
    log "== 本机自检：经代理回显 ${PROXY_IP}（直连回显 ${LOCAL_IP:-取不到}） =="
    log "   两者一致是正常的 —— 在这台机器上，代理出口就是它自己。"
  fi
fi

# ---------- 防火墙：只加规则，不擅自改默认策略 / 不擅自 enable ----------
FIREWALL_OK=0
if [[ $NO_FIREWALL -eq 1 ]]; then
  warn "按 --no-firewall 跳过 ufw：**端口当前对全公网开放**，只靠口令挡着 —— 与「独享」前提不符"
elif [[ $DRY_RUN -eq 1 ]]; then
  log "== [dry-run] 跳过 ufw =="
else
  command -v ufw >/dev/null || run apt-get install -y -qq ufw
  for cidr in "${ALLOW[@]}"; do
    ufw allow from "$cidr" to any port "$PORT" proto tcp
    [[ -n "$SOCKS5_PORT" ]] && ufw allow from "$cidr" to any port "$SOCKS5_PORT" proto tcp
  done
  if ufw status | grep -qi '^Status: active'; then
    FIREWALL_OK=1
  elif [[ $ENABLE_FIREWALL -eq 1 ]]; then
    # 一把 enable 是有可能把自己关在门外的：先把当前 SSH 会话的来源 IP 放行
    SSH_SRC="${SSH_CONNECTION%% *}"
    if [[ -n "$SSH_SRC" && "$SSH_SRC" != "127.0.0.1" ]]; then
      log "  先放行当前 SSH 来源 $SSH_SRC:22，再 enable"
      ufw allow from "$SSH_SRC" to any port 22 proto tcp
    fi
    ufw --force enable
    FIREWALL_OK=1
  fi
fi

# ---------- 摘要 ----------
PUBLIC_HINT="<本机公网IP>"
log ""
log "================ SUMMARY ================"
log "服务       : ${SERVICE_NAME}（$( [[ $DRY_RUN -eq 1 ]] && echo 'dry-run' || systemctl is-active "$SERVICE_NAME" 2>/dev/null || echo unknown )）"
log "监听       : ${PORT}${SOCKS5_PORT:+ / socks5 ${SOCKS5_PORT}}（HTTP CONNECT）"
log "认证用户   : ${PROXY_USER}"
log "口令       : ${PROXY_PASS}"
log "凭据文件   : ${AUTH_FILE}（600 root:root）"
log "白名单     : ${ALLOW[*]}"
log "二进制     : ${BIN_PATH}"
log "-----------------------------------------"
log "后台「出口管理」要填的 URL："
log "  http://${PROXY_USER}:${PROXY_PASS}@${PUBLIC_HINT}:${PORT}"
log ""
log "30 秒自检（在**项目服务器**上跑；回显本机公网 IP 即通）："
log "  curl -x http://${PROXY_USER}:${PROXY_PASS}@${PUBLIC_HINT}:${PORT} -s ${EGRESS_ECHO_URL}; echo"
log "========================================="
warn "上面这段含口令：别粘进聊天/工单/仓库。同步更新后台里的出口条目后，可用 --rotate 轮换。"

if [[ $NO_FIREWALL -eq 0 && $FIREWALL_OK -ne 1 && $DRY_RUN -eq 0 ]]; then
  warn "防火墙未生效 ⇒ 端口当前对全公网开放。放行命令已写入 ufw 规则表，但没有 enable（避免把人关在门外）。"
  warn "两种收尾：① 确认 SSH 有规则后 \`ufw enable\`；② 重跑本脚本加 --enable-firewall（会先放行当前 SSH 来源）。"
  warn "另：多数云厂商还有**安全组**这一层 —— 它不放行的话，ufw 配对了照样连不上，来源仍要限定为项目服务器 IP。"
  exit 3
fi

log "完成。下一步：把上面的 URL 填进后台出口管理 → 点「测试连接」→ 看到回显的公网 IP 即为通过。"
