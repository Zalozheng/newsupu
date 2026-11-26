/* wloc.js - Shadowrocket Lite */
const args = Object.fromEntries(
  (typeof $argument === "string" ? $argument : "")
    .split("&")
    .filter(Boolean)
    .map((kv) => kv.split("=").map(decodeURIComponent))
);

let saved = {};
try {
  const raw = $persistentStore.read("wloc_settings");
  if (raw) saved = JSON.parse(raw);
} catch {}

// 优先使用持久化存储（快捷指令保存），其次使用配置 argument
const lon = parseFloat(saved.longitude ?? args.longitude);
const lat = parseFloat(saved.latitude ?? args.latitude);
const acc = parseInt(saved.accuracy ?? args.accuracy ?? 25, 10);

function readVarint(buf, pos) {
  let val = 0, mult = 1;
  while (pos < buf.length) {
    const b = buf[pos++];
    val += (b & 0x7f) * mult;
    if (!(b & 0x80)) return [val, pos];
    mult *= 128;
  }
  throw new Error("varint eof");
}

function writeVarint(val) {
  let n = Math.floor(val);
  if (n >= 0) {
    const out = [];
    while (n >= 0x80) { out.push((n % 128) | 0x80); n = Math.floor(n / 128); }
    out.push(n);
    return out;
  }
  // 负数 64 位补码编码（用于西经/南纬）
  const bytes = new Uint8Array(8);
  let neg = -n;
  for (let i = 0; i < 8; i++) { bytes[i] = neg & 0xff; neg = Math.floor(neg / 256); }
  let carry = 1;
  for (let i = 0; i < 8; i++) { const v = (~bytes[i] & 0xff) + carry; bytes[i] = v & 0xff; carry = v >> 8; }
  const out = [];
  for (let i = 0; i < 10; i++) {
    let b = 0;
    for (let bit = 0; bit < 7; bit++) {
      const idx = i * 7 + bit;
      if (idx < 64) b |= ((bytes[idx >> 3] >> (idx & 7)) & 1) << bit;
    }
    if (i < 9) b |= 0x80;
    out.push(b);
  }
  return out;
}

function patchLocationMsg(buf) {
  let pos = 0, hasLat = false, hasLon = false;
  const chunks = [];
  while (pos < buf.length) {
    const start = pos;
    const [tag, next] = readVarint(buf, pos);
    pos = next;
    const field = tag >> 3, wire = tag & 7;
    if (wire === 0) {
      const [, end] = readVarint(buf, pos);
      if (field === 1) { hasLat = true; chunks.push(...writeVarint(tag), ...writeVarint(Math.round(lat * 1e8))); }
      else if (field === 2) { hasLon = true; chunks.push(...writeVarint(tag), ...writeVarint(Math.round(lon * 1e8))); }
      else if (field === 3) { chunks.push(...writeVarint(tag), ...writeVarint(acc)); }
      else chunks.push(...buf.slice(start, end));
      pos = end;
    } else if (wire === 1) { chunks.push(...buf.slice(start, pos + 8)); pos += 8; }
    else if (wire === 2) { const [len, end] = readVarint(buf, pos); chunks.push(...buf.slice(start, end + len)); pos = end + len; }
    else if (wire === 5) { chunks.push(...buf.slice(start, pos + 4)); pos += 4; }
    else throw new Error("bad wire");
  }
  return hasLat && hasLon ? new Uint8Array(chunks) : buf;
}

function walkProto(buf, state) {
  let pos = 0;
  const chunks = [];
  while (pos < buf.length) {
    const start = pos;
    const [tag, next] = readVarint(buf, pos);
    pos = next;
    const field = tag >> 3, wire = tag & 7;
    if (wire === 2) {
      const [len, end] = readVarint(buf, pos);
      const inner = buf.slice(end, end + len);
      pos = end + len;
      if (field === 2 || field === 5 || field === 22 || field === 24) {
        try {
          const patched = field === 2 || field === 5 ? patchLocationMsg(inner) : walkProto(inner, state);
          if (patched !== inner) state.count++;
          chunks.push(...writeVarint(tag), ...writeVarint(patched.length), ...patched);
          continue;
        } catch {}
      }
      chunks.push(...buf.slice(start, pos));
    } else if (wire === 0) { const [, end] = readVarint(buf, pos); chunks.push(...buf.slice(start, end)); pos = end; }
    else if (wire === 1) { chunks.push(...buf.slice(start, pos + 8)); pos += 8; }
    else if (wire === 5) { chunks.push(...buf.slice(start, pos + 4)); pos += 4; }
    else throw new Error("bad wire");
  }
  return new Uint8Array(chunks);
}

(() => {
  if (typeof $response === "undefined" || !$response.body || isNaN(lon) || isNaN(lat)) {
    return $done({});
  }
  const raw = $response.body instanceof Uint8Array ? $response.body : new Uint8Array($response.body);
  const state = { count: 0 };
  // 扫描 WLOC 响应体中的 Protobuf 帧头偏移
  for (let offset = 0; offset <= Math.min(64, raw.length - 10); offset++) {
    try {
      const payload = raw.slice(offset);
      const patched = walkProto(payload, state);
      if (state.count > 0) {
        const out = new Uint8Array(offset + patched.length);
        out.set(raw.slice(0, offset), 0);
        out.set(patched, offset);
        console.log(`[wloc] 成功注入坐标: ${lon}, ${lat} (patched=${state.count}, offset=${offset})`);
        const headers = { ...$response.headers };
        delete headers["Content-Length"];
        delete headers["content-length"];
        return $done({ status: 200, headers, body: out });
      }
    } catch {}
  }
  console.log(`[wloc] 未匹配到可修改帧 (len=${raw.length}, head=${raw[0]},${raw[1]})`);
  $done({});
})();
