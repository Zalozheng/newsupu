/* wloc.js - Shadowrocket Lite (Fixed Framing & Protobuf) */
(() => {
  const url = typeof $request !== "undefined" ? $request.url || "" : "";

  // 1. 响应阶段：解析 WLOC 帧头并改写 Protobuf 坐标
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

    const raw = $response.body instanceof Uint8Array ? $response.body : new Uint8Array($response.body);
    if (raw.length < 10) return $done({});
    if (raw[0] === 0x1f && raw[1] === 0x8b) {
      console.log("[wloc] 响应为 Gzip 压缩流，请确认已启用 WLOC Req 规则去掉 Accept-Encoding");
      return $done({});
    }

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

    const parseFields = (buf) => {
      const fields = [];
      let pos = 0;
      while (pos < buf.length) {
        const start = pos;
        const [tag, next] = readVarint(buf, pos);
        pos = next;
        const field = Math.floor(tag / 8), wire = tag & 7;
        if (field === 0) throw new Error("field0");
        let val;
        if (wire === 0) { [val, pos] = readVarint(buf, pos); }
        else if (wire === 1) { val = buf.slice(pos, pos + 8); pos += 8; }
        else if (wire === 2) { const [len, end] = readVarint(buf, pos); val = buf.slice(end, end + len); pos = end + len; }
        else if (wire === 5) { val = buf.slice(pos, pos + 4); pos += 4; }
        else throw new Error("wire");
        fields.push({ field, wire, val, raw: buf.slice(start, pos) });
      }
      return fields;
    };

    const encodeLenField = (field, bytes) => [...writeVarint(field * 8 + 2), ...writeVarint(bytes.length), ...bytes];

    const patchLoc = (buf, state) => {
      const fields = parseFields(buf);
      const hasLat = fields.some((f) => f.field === 1 && f.wire === 0);
      const hasLon = fields.some((f) => f.field === 2 && f.wire === 0);
      if (!hasLat || !hasLon) return buf;
      const out = [];
      for (const f of fields) {
        if (f.field === 1 && f.wire === 0) out.push(...writeVarint(8), ...writeVarint(Math.round(lat * 1e8)));
        else if (f.field === 2 && f.wire === 0) out.push(...writeVarint(16), ...writeVarint(Math.round(lon * 1e8)));
        else if (f.field === 3 && f.wire === 0) out.push(...writeVarint(24), ...writeVarint(acc));
        else out.push(...f.raw);
      }
      state.count++;
      return new Uint8Array(out);
    };

    const patchWifi = (buf, state) => {
      const fields = parseFields(buf);
      const isMac = fields.some((f) => {
        if (f.field !== 1 || f.wire !== 2) return false;
        const s = Array.from(f.val, (b) => String.fromCharCode(b)).join("");
        return /^[0-9a-fA-F]{1,2}(:[0-9a-fA-F]{1,2}){5}$/.test(s);
      });
      if (!isMac) return buf;
      const out = [];
      for (const f of fields) {
        if (f.field === 2 && f.wire === 2) {
          try { out.push(...encodeLenField(2, patchLoc(f.val, state))); continue; } catch {}
        }
        out.push(...f.raw);
      }
      return new Uint8Array(out);
    };

    const patchCell = (buf, state) => {
      const fields = parseFields(buf);
      const out = [];
      for (const f of fields) {
        if (f.field === 5 && f.wire === 2) {
          try { out.push(...encodeLenField(5, patchLoc(f.val, state))); continue; } catch {}
        }
        out.push(...f.raw);
      }
      return new Uint8Array(out);
    };

    const patchRoot = (buf, state) => {
      const fields = parseFields(buf);
      const out = [];
      for (const f of fields) {
        if (f.wire === 2 && f.field === 2) out.push(...encodeLenField(2, patchWifi(f.val, state)));
        else if (f.wire === 2 && (f.field === 22 || f.field === 24)) out.push(...encodeLenField(f.field, patchCell(f.val, state)));
        else out.push(...f.raw);
      }
      return new Uint8Array(out);
    };

    // 扫描 10 字节 WLOC 帧头并更新 2 字节大端长度
    for (let base = 0; base <= Math.min(96, raw.length - 10); base++) {
      const len = (raw[base + 8] << 8) | raw[base + 9];
      if (len <= 0 || base + 10 + len > raw.length) continue;
      const state = { count: 0 };
      try {
        const patched = patchRoot(raw.slice(base + 10, base + 10 + len), state);
        if (state.count > 0 && patched.length <= 65535) {
          const tail = raw.slice(base + 10 + len);
          const out = new Uint8Array(base + 10 + patched.length + tail.length);
          out.set(raw.slice(0, base + 8), 0);
          out[base + 8] = (patched.length >> 8) & 0xff;
          out[base + 9] = patched.length & 0xff;
          out.set(patched, base + 10);
          out.set(tail, base + 10 + patched.length);
          console.log(`[wloc] 注入成功: ${lon},${lat} (offset=${base}, patched=${state.count})`);
          const headers = { ...$response.headers };
          delete headers["Content-Encoding"];
          delete headers["content-encoding"];
          delete headers["Transfer-Encoding"];
          delete headers["transfer-encoding"];
          headers["Content-Length"] = String(out.length);
          return $done({ status: 200, headers, body: out });
        }
      } catch {}
    }
    console.log(`[wloc] 未匹配到可改写帧 (len=${raw.length})`);
    return $done({});
  }

  // 2. 请求阶段：处理 /wloc-settings/save 坐标保存
  if (url.includes("/wloc-settings/save")) {
    const query = url.split("?")[1] || "";
    const params = Object.fromEntries(query.split("&").filter(Boolean).map((kv) => kv.split("=").map(decodeURIComponent)));
    const lat = parseFloat(params.lat ?? params.latitude);
    const lon = parseFloat(params.lon ?? params.longitude);
    const acc = parseInt(params.acc ?? params.accuracy ?? 25, 10);
    if (!isNaN(lat) && !isNaN(lon)) {
      $persistentStore.write(JSON.stringify({ latitude: lat, longitude: lon, accuracy: acc }), "wloc_settings");
      return $done({ response: { status: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ok: true, lat, lon, acc }) } });
    }
    return $done({ response: { status: 400, body: "invalid params" } });
  }

  // 3. 请求阶段：移除 Accept-Encoding 防止返回 Gzip
  const headers = { ...$request.headers };
  delete headers["Accept-Encoding"];
  delete headers["accept-encoding"];
  $done({ headers });
})();
