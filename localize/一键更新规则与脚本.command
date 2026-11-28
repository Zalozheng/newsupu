#!/bin/bash
# Shadowrocket 配置一键编译 / 全量更新 / 仅更新脚本 / 去重清理工具（macOS 单命令交互版）
# 模式说明：
#   [1] 仅编译（优先用本地 Rules/Scripts 缓存，缺失自动补下载）
#   [2] 全量更新并编译（重新拉取模板中全部远程规则集与脚本）
#   [3] 仅更新 JS 脚本（只拉取模板中远程脚本并同步到 iCloud Script/）
#   [4] 清理重复规则（排在前面的规则优先保留，自动删除后面重复及被前序 DOMAIN-SUFFIX 覆盖的冗余域名/IP，并同步到 localize 与 iCloud）

set -u

LOCAL_DIR="$(cd "$(dirname "$0")" && pwd)"
LOCAL_SCRIPTS="$LOCAL_DIR/Scripts"
LOCAL_RULES="$LOCAL_DIR/Rules"
TEMPLATE_CONF="$LOCAL_DIR/template.conf"
OUT_NAME="autossr_local.conf"
OUT_CONF="$LOCAL_DIR/$OUT_NAME"

TARGET_LOCALIZE_DIR="/Users/zalo/newsupu/localize"
ICLOUD_SR_DIR="$HOME/Library/Mobile Documents/iCloud~com~liguangming~Shadowrocket/Documents"
ICLOUD_SCRIPT_DIR="$ICLOUD_SR_DIR/Script"

mkdir -p "$LOCAL_SCRIPTS" "$LOCAL_RULES"

echo "=================================================="
echo "  Shadowrocket 本地化配置编译 & 更新 & 去重工具"
echo "  时间: $(date '+%Y-%m-%d %H:%M:%S')"
echo "=================================================="
echo ""

if [[ ! -f "$TEMPLATE_CONF" ]]; then
  echo "  [错误] 未找到模板文件: $TEMPLATE_CONF"
  exit 1
fi

MODE="${1:-}"
if [[ -z "$MODE" ]]; then
  echo "请选择执行模式："
  echo "  [1] 仅编译（检查本地 Rules/Scripts，已有就不下载，缺失自动补下）"
  echo "  [2] 全量更新并编译（重新从 GitHub 拉取模板中全部规则与脚本）"
  echo "  [3] 仅更新 JS 脚本（只拉取远程脚本并同步到 iCloud Script/）"
  echo "  [4] 清理重复域名/IP 等冗余规则（顶部优先保留，自动删除后方重复项并同步）"
  echo ""
  read -r -p "请输入 1、2、3 或 4（默认 1，直接回车即可）: " CHOICE
  case "${CHOICE:-1}" in
    2) MODE="update" ;;
    3) MODE="scripts" ;;
    4) MODE="dedup" ;;
    *) MODE="build" ;;
  esac
fi

echo ""
case "$MODE" in
  update)  echo "▶ 当前模式：[2] 全量更新并编译" ;;
  scripts) echo "▶ 当前模式：[3] 仅更新 JS 脚本" ;;
  dedup)   echo "▶ 当前模式：[4] 清理重复域名/IP 等冗余规则（顶部优先保留）" ;;
  *)       echo "▶ 当前模式：[1] 仅编译（本地已有缓存将跳过下载）" ;;
esac
echo ""

python3 - "$LOCAL_DIR" "$TEMPLATE_CONF" "$OUT_CONF" "$MODE" <<'PYEOF'
import hashlib, ipaddress, os, re, subprocess, sys, tempfile
from datetime import datetime
from urllib.parse import urlparse

local_dir = sys.argv[1]
tpl_path = sys.argv[2]
out_conf = sys.argv[3]
mode = sys.argv[4]  # "build" | "update" | "scripts" | "dedup"

scripts_dir = os.path.join(local_dir, "Scripts")
rules_dir = os.path.join(local_dir, "Rules")

QX_TYPE_MAP = {
    "HOST": "DOMAIN",
    "HOST-SUFFIX": "DOMAIN-SUFFIX",
    "HOST-KEYWORD": "DOMAIN-KEYWORD",
    "HOST-WILDCARD": "DOMAIN-WILDCARD",
    "IP6-CIDR": "IP-CIDR",
}
VALID_SR_TYPES = {
    "DOMAIN", "DOMAIN-SUFFIX", "DOMAIN-KEYWORD", "DOMAIN-WILDCARD",
    "IP-CIDR", "IP-ASN", "USER-AGENT", "URL-REGEX", "GEOIP", "DST-PORT", "PROTOCOL"
}

def deduplicate_conf_lines(lines):
    """在 [Rule] 段中执行严格顶部优先去重：
    1. 相同 (规则类型, 规范化匹配目标) 只保留最先出现的一条；
    2. 若前面已出现 DOMAIN-SUFFIX,example.com，则后面所有等于 example.com 或以 .example.com 结尾的 DOMAIN / DOMAIN-SUFFIX 均视为冗余并删除；
    3. IP-CIDR 按标准网络格式规范化后再比对去重；
    4. 非 [Rule] 段、注释、空行、GEOIP、FINAL 原样保留。
    """
    in_rule = False
    seen_exact = set()
    seen_suffixes = set()  # lowercased suffix without leading dot
    cleaned = []
    removed_exact = 0
    removed_covered = 0
    kept_rules = 0

    def is_covered_by_prev_suffix(domain):
        # 检查 domain 本身及其所有父级后缀是否已在前序 DOMAIN-SUFFIX 中出现
        d = domain.lower().lstrip(".")
        parts = d.split(".")
        for i in range(len(parts)):
            cand = ".".join(parts[i:])
            if cand in seen_suffixes:
                return True
        return False

    for line in lines:
        s = line.strip()
        if re.match(r"^\[.+\]$", s):
            in_rule = (s.lower() == "[rule]")
            cleaned.append(line)
            continue

        if not in_rule or not s or s.startswith("#") or s.startswith(";"):
            cleaned.append(line)
            continue

        parts = [p.strip() for p in s.split(",")]
        rtype = parts[0].upper()

        # 兜底或逻辑组合规则不去重，原样保留
        if rtype in ("FINAL", "GEOIP", "AND", "OR", "NOT") or len(parts) < 2:
            cleaned.append(line)
            kept_rules += 1
            continue

        val = parts[1].strip()
        norm_val = val.lower()

        if rtype == "IP-CIDR":
            try:
                norm_val = str(ipaddress.ip_network(val, strict=False))
            except ValueError:
                pass
        elif rtype in ("DOMAIN", "DOMAIN-SUFFIX"):
            norm_val = norm_val.lstrip(".")
            # 如果前面已有更宽泛或相同的 DOMAIN-SUFFIX，则当前规则永远不会被命中，直接删除
            if is_covered_by_prev_suffix(norm_val):
                removed_covered += 1
                continue

        key = (rtype, norm_val)
        if key in seen_exact:
            removed_exact += 1
            continue

        seen_exact.add(key)
        if rtype == "DOMAIN-SUFFIX":
            seen_suffixes.add(norm_val)

        cleaned.append(line)
        kept_rules += 1

    return cleaned, kept_rules, removed_exact, removed_covered

# 模式 4：直接对现有 autossr_local.conf 执行去重（若不存在则提示先编译）
if mode == "dedup":
    if not os.path.exists(out_conf):
        print(f"  [提示] 尚未生成 {os.path.basename(out_conf)}，请先运行模式 [1] 编译后再去重。")
        sys.exit(1)
    with open(out_conf, "r", encoding="utf-8") as f:
        orig_lines = [l.rstrip("\r\n") for l in f]
    cleaned, kept, rm_exact, rm_cov = deduplicate_conf_lines(orig_lines)
    total_rm = rm_exact + rm_cov
    with open(out_conf, "w", encoding="utf-8") as f:
        f.write("\n".join(cleaned) + "\n")
    print(f"  [OK] 去重完成！保留有效规则: {kept} 条")
    print(f"       ↳ 共删除冗余规则: {total_rm} 条（完全重复: {rm_exact} 条 | 被前序 DOMAIN-SUFFIX 覆盖: {rm_cov} 条）")
    sys.exit(0)

with open(tpl_path, "r", encoding="utf-8") as f:
    tpl_lines = [line.rstrip("\r\n") for line in f]

script_re = re.compile(r"(script-path\s*=\s*)(https?://[^,\s]+)")
script_urls = []
rule_urls = []

for line in tpl_lines:
    s = line.strip()
    if not s or s.startswith("#") or s.startswith(";"):
        continue
    m = script_re.search(line)
    if m:
        url = m.group(2)
        if url not in script_urls:
            script_urls.append(url)
    if s.upper().startswith("RULE-SET,"):
        parts = [p.strip() for p in s.split(",")]
        if len(parts) >= 3 and re.match(r"^https?://", parts[1], re.I):
            url = parts[1]
            if url not in rule_urls:
                rule_urls.append(url)

def make_cache_names(urls):
    base_counts = {}
    bases = []
    for u in urls:
        b = os.path.basename(urlparse(u).path) or "unnamed.list"
        bases.append(b)
        base_counts[b] = base_counts.get(b, 0) + 1
    mapping = {}
    for u, b in zip(urls, bases):
        if base_counts[b] > 1:
            stem, ext = os.path.splitext(b)
            h = hashlib.md5(u.encode("utf-8")).hexdigest()[:6]
            mapping[u] = f"{stem}_{h}{ext}"
        else:
            mapping[u] = b
    return mapping

script_name_map = make_cache_names(script_urls)
rule_name_map = make_cache_names(rule_urls)

dl_ok = 0
dl_skip = 0
dl_fail = 0

def ensure_file(url, dest, label, force_download):
    global dl_ok, dl_skip, dl_fail
    if not force_download and os.path.exists(dest) and os.path.getsize(dest) > 0:
        dl_skip += 1
        return True
    with tempfile.NamedTemporaryFile(delete=False) as tf:
        tmp_path = tf.name
    try:
        res = subprocess.run(
            ["curl", "-sSL", "-w", "%{http_code}", "--connect-timeout", "15", "--max-time", "60", "-o", tmp_path, url],
            capture_output=True, text=True
        )
        code = res.stdout.strip()
        if code == "200" and os.path.getsize(tmp_path) > 0:
            os.replace(tmp_path, dest)
            with open(dest, "r", encoding="utf-8", errors="replace") as f:
                cnt = sum(1 for _ in f)
            tag = "更新" if force_download else "补下载"
            print(f"  [{tag} OK] {label} ({cnt} 行)")
            dl_ok += 1
            return True
        else:
            print(f"  [下载失败] {label} (HTTP {code}，保留本地旧缓存)")
            dl_fail += 1
            return False
    except Exception as e:
        print(f"  [下载失败] {label} ({e}，保留本地旧缓存)")
        dl_fail += 1
        return False
    finally:
        if os.path.exists(tmp_path):
            try:
                os.remove(tmp_path)
            except OSError:
                pass

force_scripts = mode in ("update", "scripts")
print(f"【1/3】检查/更新 JS 脚本（模板共引用 {len(script_urls)} 个）...")
for u in script_urls:
    fname = script_name_map[u]
    ensure_file(u, os.path.join(scripts_dir, fname), fname, force_scripts)
if not force_scripts and dl_ok == 0 and dl_fail == 0:
    print("  [跳过] 全部脚本本地已存在，无需下载")

if mode == "scripts":
    print(f"\n  [脚本统计] 更新成功: {dl_ok} | 失败: {dl_fail}")
    sys.exit(0)

prev_ok, prev_fail = dl_ok, dl_fail
force_rules = mode == "update"
print("")
print(f"【2/3】检查/更新规则集（模板共引用 {len(rule_urls)} 份）...")
for u in rule_urls:
    fname = rule_name_map[u]
    ensure_file(u, os.path.join(rules_dir, fname), fname, force_rules)
if not force_rules and dl_ok == prev_ok and dl_fail == prev_fail:
    print("  [跳过] 全部规则集本地已存在，无需下载")

def expand_rule_file(path, policy):
    if not os.path.exists(path):
        print(f"  [警告] 缺少本地规则文件: {os.path.basename(path)}（已跳过）")
        return []
    converted = []
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        for raw in f:
            line = raw.strip()
            if not line or line.startswith("#") or line.startswith(";"):
                continue
            parts = [p.strip() for p in line.split(",")]
            if len(parts) < 2:
                continue
            raw_type = parts[0].upper()
            is_qx = raw_type in QX_TYPE_MAP
            rtype = QX_TYPE_MAP.get(raw_type, raw_type)
            if rtype not in VALID_SR_TYPES:
                continue
            val = parts[1]
            rest = [p.lower() for p in parts[2:]]
            has_no_resolve = "no-resolve" in rest
            if rtype in ("IP-CIDR", "IP-ASN") and (has_no_resolve or is_qx or len(parts) >= 3):
                converted.append(f"{rtype},{val},{policy},no-resolve")
            else:
                converted.append(f"{rtype},{val},{policy}")
    return converted

print("")
print("【3/3】按 template.conf 内联展开规则并本地化脚本路径...")
now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
out_lines = [
    "# Shadowrocket 自动编译生成的最终离线配置（请勿直接编辑本文件，修改请编辑 template.conf）",
    f"# 编译时间: {now_str}",
    "",
]

total_rules = 0
expanded_sets = 0
localized_scripts = 0

for line in tpl_lines:
    s = line.strip()
    if s and not s.startswith("#") and not s.startswith(";"):
        if s.upper().startswith("RULE-SET,"):
            parts = [p.strip() for p in s.split(",")]
            if len(parts) >= 3 and re.match(r"^https?://", parts[1], re.I):
                url, policy = parts[1], parts[2]
                fname = rule_name_map[url]
                rules = expand_rule_file(os.path.join(rules_dir, fname), policy)
                expanded_sets += 1
                total_rules += len(rules)
                out_lines.append(f"# --- 展开自 {fname} | 策略: {policy} | 共 {len(rules)} 条 ---")
                out_lines.extend(rules)
                continue
        elif s.upper().startswith("LOCAL-RULE-SET,"):
            parts = [p.strip() for p in s.split(",")]
            if len(parts) >= 3:
                rel_path, policy = parts[1], parts[2]
                rules = expand_rule_file(os.path.join(local_dir, rel_path), policy)
                expanded_sets += 1
                total_rules += len(rules)
                out_lines.append(f"# --- 展开自 {os.path.basename(rel_path)} | 策略: {policy} | 共 {len(rules)} 条 ---")
                out_lines.extend(rules)
                continue
        m = script_re.search(line)
        if m:
            url = m.group(2)
            fname = script_name_map[url]
            line = script_re.sub(rf"\1Script/{fname}", line)
            localized_scripts += 1
    out_lines.append(line)

with open(out_conf, "w", encoding="utf-8") as f:
    f.write("\n".join(out_lines) + "\n")

print(f"  [OK] 已展开 {expanded_sets} 份规则集（共 {total_rules} 条规则），已本地化 {localized_scripts} 条脚本规则")
print(f"  [缓存统计] 下载: {dl_ok} | 复用本地缓存: {dl_skip} | 失败: {dl_fail}")
PYEOF

PY_EXIT=$?
if [[ "$PY_EXIT" -ne 0 ]]; then
  echo ""
  echo "  [中止] 执行未完成，请检查上述提示。"
  if [[ -z "${1:-}" ]]; then
    read -n 1 -s -r -p "按任意键关闭窗口..."
    echo ""
  fi
  exit "$PY_EXIT"
fi

echo ""
echo "【同步输出】"
if [[ "$MODE" == "scripts" ]]; then
  if [[ -d "$ICLOUD_SR_DIR" ]]; then
    mkdir -p "$ICLOUD_SCRIPT_DIR"
    if ls "$LOCAL_SCRIPTS/"*.js >/dev/null 2>&1; then
      cp -f "$LOCAL_SCRIPTS/"*.js "$ICLOUD_SCRIPT_DIR/"
      echo "  [OK] 已同步最新脚本至: $ICLOUD_SCRIPT_DIR"
    fi
  else
    echo "  [提示] 未找到 iCloud Shadowrocket 目录，最新脚本已保存在: $LOCAL_SCRIPTS"
  fi
  echo ""
  echo "=================================================="
  echo "  JS 脚本更新完成！在 Shadowrocket 重新编译配置或重连即可生效"
  echo "=================================================="
else
  echo "  ★ 生成配置名称: $OUT_NAME"
  echo "  ★ 本地生成路径: $OUT_CONF"

  mkdir -p "$TARGET_LOCALIZE_DIR"
  if [[ "$LOCAL_DIR" != "$TARGET_LOCALIZE_DIR" ]]; then
    cp -f "$OUT_CONF" "$TARGET_LOCALIZE_DIR/$OUT_NAME"
    echo "  [OK] 已覆盖复制到: $TARGET_LOCALIZE_DIR/$OUT_NAME"
  else
    echo "  [OK] 已直接覆盖输出到 localize 目录: $OUT_CONF"
  fi

  if [[ -d "$ICLOUD_SR_DIR" ]]; then
    mkdir -p "$ICLOUD_SCRIPT_DIR"
    if ls "$LOCAL_SCRIPTS/"*.js >/dev/null 2>&1; then
      cp -f "$LOCAL_SCRIPTS/"*.js "$ICLOUD_SCRIPT_DIR/"
      echo "  [OK] 已同步脚本至: $ICLOUD_SCRIPT_DIR"
    fi
    cp -f "$OUT_CONF" "$ICLOUD_SR_DIR/$OUT_NAME"
    echo "  [OK] 已覆盖同步至: $ICLOUD_SR_DIR/$OUT_NAME"
  fi

  echo ""
  echo "=================================================="
  echo "  全部完成！生成文件：$OUT_NAME"
  echo "  下一步：打开 Shadowrocket -> 配置 -> 点击 $OUT_NAME -> 使用配置 / 编译配置"
  echo "=================================================="
fi

if [[ -z "${1:-}" ]]; then
  echo ""
  read -n 1 -s -r -p "按任意键关闭窗口..."
  echo ""
fi
