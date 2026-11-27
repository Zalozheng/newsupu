/* wloc.js - Shadowrocket Final (Request + Save + Response) */
(() => {
  const url = typeof $request !== "undefined" ? $request.url || "" : "";

  // 1. 响应阶段：改写 WLOC 二进制 Protobuf 坐标
  if (typeof $response !== "undefined") {
    if (!$response.body) return $done({});

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

    const lon = parseFloat(saved.longitude ?? args.longitude);
    const lat = parseFloat(saved.latitude ?? args.latitude);
    const acc = parseInt(saved.accuracy ?? args.accuracy ?? 25, 10);

    if (isNaN(lon) || isNaN(lat)) return $done({});

    const readVarint = (buf, pos) => {
      let val = 0, mult = 1;
      while (pos < buf.length) {
        const b = buf[pos++];
        val += (b & 0x7f) * mult;
        if (!(b & 0x80)) return [val, pos];
        mult *= 128;
      }
      throw new Error("eof");
    };

    const writeVarint = (val) => {
      let n = Math.floor(val);
      if (n >= 0) {
        const out = [];
        while (n >= 0x80) { out.push((n % 128) | 0x80); n = Math.floor(n / 128); }
        out.push(n);
        return out;
      }
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
    };

    const patchLoc = (buf) => {
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
        else throw new Error("wire");
      }
      return hasLat && hasLon ? new Uint8Array(chunks) : buf;
    };

    const walkProto = (buf, state) => {
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
              const patched = field === 2 || field === 5 ? patchLoc(inner) : walkProto(inner, state);
              if (patched !== inner) state.count++;
              chunks.push(...writeVarint(tag), ...writeVarint(patched.length), ...patched);
              continue;
            } catch {}
          }
          chunks.push(...buf.slice(start, pos));
        } else if (wire === 0) { const [, end] = readVarint(buf, pos); chunks.push(...buf.slice(start, end)); pos = end; }
        else if (wire === 1) { chunks.push(...buf.slice(start, pos + 8)); pos += 8; }
        else if (wire === 5) { chunks.push(...buf.slice(start, pos + 4)); pos += 4; }
        else throw new Error("wire");
      }
      return new Uint8Array(chunks);
    };

    const raw = $response.body instanceof Uint8Array ? $response.body : new Uint8Array($response.body);
    const state = { count: 0 };
    for (let offset = 0; offset <= Math.min(64, raw.length - 10); offset++) {
      try {
        const patched = walkProto(raw.slice(offset), state);
        if (state.count > 0) {
          const out = new Uint8Array(offset + patched.length);
          out.set(raw.slice(0, offset), 0);
          out.set(patched, offset);
          console.log(`[wloc] 注入成功: ${lon},${lat} (patched=${state.count})`);
          const headers = { ...$response.headers };
          delete headers["Content-Length"];
          delete headers["content-length"];
          return $done({ headers, body: out });
        }
      } catch {}
    }
    return $done({});
  }

  // 2. 请求阶段：处理 /wloc-settings/save 坐标写入接口
  if (url.includes("/wloc-settings/save")) {
    const query = url.split("?")[1] || "";
    const params = Object.fromEntries(query.split("&").filter(Boolean).map((kv) => kv.split("=").map(decodeURIComponent)));
    const lat = parseFloat(params.lat ?? params.latitude);
    const lon = parseFloat(params.lon ?? params.longitude);
    const acc = parseInt(params.acc ?? params.accuracy ?? 25, 10);
    if (!isNaN(lat) && !isNaN(lon)) {
      $persistentStore.write(JSON.stringify({ latitude: lat, longitude: lon, accuracy: acc }), "wloc_settings");
      console.log(`[wloc] 已保存坐标: ${lon},${lat}`);
      return $done({ response: { status: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ok: true, lat, lon, acc }) } });
    }
    return $done({ response: { status: 400, body: "invalid params" } });
  }

  // 3. 请求阶段：移除 Accept-Encoding 确保返回未压缩二进制流
  const headers = { ...$request.headers };
  delete headers["Accept-Encoding"];
  delete headers["accept-encoding"];
  $done({ headers });
})();
