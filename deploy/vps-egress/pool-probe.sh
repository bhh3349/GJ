#!/usr/bin/env bash
#
# 出口池健康探测（**运维工具，不是运行时选路**）
#
# 定位说清楚，免得长出第二套状态机：
#   - 本脚本 = 一次性/定时体检 + S4 标定取证。**无状态**：不摘除、不回池、不记忆。
#   - 网关侧的「按延迟最优选出口 / 连续 3 次失败摘除 / 回池滞回 5min」是运行时逻辑，
#     归路由者（dev/gateway-rotation，ADR-0021 决策 8）。两边判据是否共用一份实现，
#     由路由者定；本脚本只保证**输出形状稳定可解析**。
#   - 出口清单的**事实源是 egress_proxies 表**（走 /api/egress）。本脚本读的 TSV 是运维输入
#     （装机自检、标定期、DB 尚未建档时用），不是网关的配置源。见 README §事实源。
#
# 用法：
#   ./pool-probe.sh --nodes /etc/sub2api/egress-nodes.tsv
#   ./pool-probe.sh --nodes nodes.example.tsv --json
#
# 退出码：0 = 全部健康；1 = 有节点不健康；2 = 用法/输入不合法。
#
set -euo pipefail

NODES_FILE="${NODES_FILE:-/etc/sub2api/egress-nodes.tsv}"
ECHO_URL="${EGRESS_ECHO_URL:-https://api.ipify.org}"
TIMEOUT=10
SLOW_MS=2000
REPEAT=1
JSON=0

log()  { printf '%s\n' "$*" >&2; }
die()  { printf 'FAIL  %s\n' "$*" >&2; exit 2; }

usage() {
  cat <<'USAGE'
用法：pool-probe.sh [选项]

  --nodes <文件>    节点清单，TSV：name<TAB>proxy_url<TAB>expected_ip(可空)<TAB>region(可空)
                    默认 /etc/sub2api/egress-nodes.tsv（600，不入仓库）
  --echo-url <URL>  回显出口 IP 的端点，默认 https://api.ipify.org
  --timeout <秒>    单次请求超时，默认 10
  --slow-ms <毫秒>  超过即标 slow（仍算 ok，只是不优），默认 2000
  --repeat <N>      每节点采样 N 次，取 min 作为 latencyMs（默认 1；N>1 时排序更稳）
  --json            输出单个 JSON 文档到 stdout（人读表走 stderr）
  -h, --help        本帮助

输出（--json）：
  { "checkedAt": ISO8601, "echoUrl": ..., "results": [
      { "name", "host", "ok", "status", "egressIp", "expectedIp",
        "latencyMs", "samples", "slow", "detail" } ] }

status 取值：ok | ip_mismatch | auth_rejected | proxy_unreachable | proxy_dns_failed
             | timeout | tls_error | bad_response | error | skipped
凭据纪律：**URL 里的 user:pass 永不进输出、日志、错误信息**。
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --nodes)    [[ $# -ge 2 ]] || die "--nodes 需要文件路径"; NODES_FILE="$2"; shift 2 ;;
    --echo-url) [[ $# -ge 2 ]] || die "--echo-url 需要 URL"; ECHO_URL="$2"; shift 2 ;;
    --timeout)  [[ $# -ge 2 ]] || die "--timeout 需要秒数"; TIMEOUT="$2"; shift 2 ;;
    --slow-ms)  [[ $# -ge 2 ]] || die "--slow-ms 需要毫秒"; SLOW_MS="$2"; shift 2 ;;
    --repeat)   [[ $# -ge 2 ]] || die "--repeat 需要次数"; REPEAT="$2"; shift 2 ;;
    --json)     JSON=1; shift ;;
    -h|--help)  usage; exit 0 ;;
    *)          die "未知参数：$1（-h 看用法）" ;;
  esac
done

command -v curl >/dev/null || die "缺少 curl"
[[ -r "$NODES_FILE" ]] || die "读不到节点清单 $NODES_FILE（先在别的机器生成后拷进来，或 --nodes 指定）"
[[ "$REPEAT" =~ ^[0-9]+$ && "$REPEAT" -ge 1 ]] || die "--repeat 要是 ≥1 的整数"

# host:port 用于人读表：去掉 scheme 与 userinfo。**不含凭据**。
host_of() {
  local u="$1"
  u="${u#*://}"; u="${u#*@}"; printf '%s' "${u%%/*}"
}
# 只取凭据部分之外的部分做校验，避免口令里的字符影响判断
scheme_of() { printf '%s' "${1%%://*}"; }
json_escape() { printf '%s' "$1" | tr -d '"\\' | tr -d '\000-\037'; }

TMPD="$(mktemp -d)"
trap 'rm -rf "$TMPD"' EXIT

CHECKED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
declare -a ROWS=()
BAD=0
N=0

while IFS= read -r line || [[ -n "${line:-}" ]]; do
  line="${line%$'\r'}"
  [[ -z "${line//[[:space:]]/}" ]] && continue
  [[ "${line:0:1}" == "#" ]] && continue

  # 手工按 TAB 切列。**不能**用 `IFS=$'\t' read -r name url expected region`：
  # TAB 属于「IFS 空白字符」，连续两个 TAB 会被并成一个分隔符 ⇒ 空列被吞掉，
  # 「hk-2<TAB>url<TAB><TAB>hk」里的 region 会串到 expected 上，ip_mismatch 判定跟着错位。
  name="${line%%$'\t'*}"
  if [[ "${line#*$'\t'}" == "$line" ]]; then
    url=""; expected=""; region=""
  else
    rest="${line#*$'\t'}"
    url="${rest%%$'\t'*}"
    if [[ "${rest#*$'\t'}" == "$rest" ]]; then
      expected=""; region=""
    else
      rest2="${rest#*$'\t'}"
      expected="${rest2%%$'\t'*}"
      if [[ "${rest2#*$'\t'}" == "$rest2" ]]; then region=""; else region="${rest2#*$'\t'}"; fi
    fi
  fi

  if [[ -z "${url:-}" ]]; then
    ROWS+=("$(printf '{"name":"%s","host":"","region":"%s","ok":false,"status":"skipped","egressIp":"","expectedIp":"","latencyMs":0,"samples":0,"slow":false,"detail":"清单该行缺少 URL"}' \
      "$(json_escape "$name")" "$(json_escape "${region:-}")")")
    log "$(printf '%-14s %-24s %-16s %8s  %s' "$name" "—" "skipped" "—" "清单该行缺少 URL")"
    BAD=$((BAD + 1)); N=$((N + 1)); continue
  fi

  N=$((N + 1))
  host="$(host_of "$url")"
  scheme="$(scheme_of "$url")"
  if [[ "$scheme" != "http" ]]; then
    # SOCKS5 不是网关的接线路径（提案 §1.1）：当场说清，别让人以为它是可用出口
    ROWS+=("$(printf '{"name":"%s","host":"%s","region":"%s","ok":false,"status":"skipped","egressIp":"","expectedIp":"%s","latencyMs":0,"samples":0,"slow":false,"detail":"scheme=%s 不受支持，网关只走 http CONNECT"}' \
      "$(json_escape "$name")" "$(json_escape "$host")" "$(json_escape "${region:-}")" "$(json_escape "${expected:-}")" "$(json_escape "$scheme")")")
    log "$(printf '%-14s %-24s %-16s %8s  %s' "$name" "$host" "skipped" "—" "scheme=$scheme 不是 http CONNECT")"
    BAD=$((BAD + 1)); continue
  fi

  best_ms=""; last_ip=""; last_rc=0; last_err=""; last_code=""; last_auth=0; samples=0
  for ((i = 0; i < REPEAT; i++)); do
    set +e
    code_lat="$(curl -sS --max-time "$TIMEOUT" -x "$url" -o "$TMPD/body" -w '%{http_code} %{time_total}' "$ECHO_URL" 2>"$TMPD/err")"
    rc=$?
    set -e
    last_rc=$rc
    last_err="$(cat "$TMPD/err" 2>/dev/null || true)"
    last_code="${code_lat%% *}"
    body="$(tr -d ' \r\n' < "$TMPD/body" 2>/dev/null || true)"

    # 明文 HTTP 目标走 absolute-form（非 CONNECT）：代理的 407 会作为**正常响应体**回来、curl 退出码为 0。
    # 不按状态码单独判一次，407 就会被当成「回显到的出口 IP」，把「口令错」误报成「IP 不对」——
    # 这正是本项目反复出现的那类误归因，所以在源头掐掉，不靠 stderr 文本去认。
    if [[ "$last_code" == "407" ]]; then last_auth=1; break; fi

    if [[ $rc -eq 0 && "$last_code" == 2* ]]; then
      samples=$((samples + 1))
      [[ -n "$body" ]] && last_ip="$body"
      ms="$(awk -v t="${code_lat##* }" 'BEGIN { printf "%d", t * 1000 + 0.5 }')"
      if [[ -z "$best_ms" || "$ms" -lt "$best_ms" ]]; then best_ms="$ms"; fi
    fi
  done

  status=""; ok=true; detail=""
  if [[ "${last_auth:-0}" -eq 1 || "$last_err" == *407* ]]; then
    status="auth_rejected"; ok=false
    detail="代理拒绝认证（407）：用户名/口令不符 —— 不是「IP 不对」"
  elif [[ $samples -gt 0 ]]; then
    if [[ ! "$last_ip" =~ ^[0-9a-fA-F:.]{3,45}$ ]]; then
      # 回显端点被中间层改写（门户劫持 / 返回 HTML）时，别把它当成 IP 拿去比对
      status="bad_response"; ok=false
      detail="回显端点返回的不是 IP（HTTP ${last_code}）"
    elif [[ -n "${expected:-}" && "$last_ip" != "$expected" ]]; then
      status="ip_mismatch"; ok=false
      detail="回显 $last_ip，与清单登记不一致 ⇒ 这个 URL 没从这个出口出去"
    else
      status="ok"
    fi
  elif [[ -n "$last_code" && "$last_code" != "000" ]]; then
    status="error"; ok=false; detail="回显端点返回 HTTP ${last_code}"
  else
    case "$last_rc" in
      5)  status="proxy_dns_failed"; detail="解析不到代理主机名（清单里的 host 写错了？）" ;;
      7)  status="proxy_unreachable"; detail="连不上代理端口（VPS 挂了 / 安全组或 ufw 没放行本机 IP）" ;;
      28) status="timeout"; detail="超时（${TIMEOUT}s）：链路慢或被丢弃" ;;
      35|51|53|54|58|59|60|77|90|91) status="tls_error"; detail="TLS 失败（回显端点的证书链问题）" ;;
      *)  status="error"; detail="curl 退出码 $last_rc" ;;
    esac
    ok=false
  fi

  if [[ "$status" == "ok" && -n "$best_ms" && "$best_ms" -gt "$SLOW_MS" ]]; then
    slow=true
  else
    slow=false
  fi

  ROWS+=("$(printf '{"name":"%s","host":"%s","region":"%s","ok":%s,"status":"%s","egressIp":"%s","expectedIp":"%s","latencyMs":%s,"samples":%s,"slow":%s,"detail":"%s"}' \
    "$(json_escape "$name")" "$(json_escape "$host")" "$(json_escape "${region:-}")" "$ok" "$status" "$(json_escape "$last_ip")" \
    "$(json_escape "${expected:-}")" "${best_ms:-0}" "$samples" "$slow" "$(json_escape "$detail")")")

  if [[ $ok == false ]]; then BAD=$((BAD + 1)); fi
  log "$(printf '%-14s %-24s %-16s %8s  %s' "$name" "$host" "$status" "${best_ms:-—}ms" "$last_ip")"
done < "$NODES_FILE"

[[ $N -gt 0 ]] || die "清单里没有可探测的行：$NODES_FILE"

if [[ $JSON -eq 1 ]]; then
  printf '{"checkedAt":"%s","echoUrl":"%s","results":[\n  %s\n]}\n' \
    "$CHECKED_AT" "$(json_escape "$ECHO_URL")" "$(IFS=$',\n  '; printf '%s' "${ROWS[*]}")"
else
  log ""
  log "checkedAt=$CHECKED_AT  节点=$N  不健康=$BAD"
fi

if [[ $BAD -gt 0 ]]; then exit 1; fi
exit 0
