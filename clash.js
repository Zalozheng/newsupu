// 保留订阅内的全部节点（不做地区筛选）
// 只有一个分组：自动测速（600秒间隔 + 200ms容差，减少频繁跳节点触发人机验证）
// 保留 IPv6 + 银行 App 绕过 Fake-IP + TikTok/Gemini 屏蔽 QUIC 防卡顿 + YouTube 放行 QUIC
function main(config) {
  const allProxies = config.proxies || [];

  config["proxy-groups"] = allProxies.length
    ? [{
        name: "🚀 节点选择",
        type: "url-test",
        url: "http://www.gstatic.com/generate_204",
        interval: 600,
        tolerance: 200,
        timeout: 3000,
        proxies: allProxies.map((p) => p.name),
      }]
    : [{ name: "🚀 节点选择", type: "select", proxies: ["DIRECT"] }];

  config.ipv6 = true;

  config.dns = {
    enable: true,
    ipv6: true,
    "enhanced-mode": "fake-ip",
    "fake-ip-range": "198.18.0.1/16",
    "fake-ip-filter": [
      "*.lan",
      "*.local",
      "+.msftconnecttest.com",
      "+.msftncsi.com",
      "localhost.ptlogin2.qq.com",
      "+.weixin.qq.com",
      "+.cmbchina.com",
      "+.icbc.com.cn",
      "+.ccb.com",
      "+.abchina.com",
      "+.boc.cn",
      "+.bankcomm.com",
      "+.psbc.com",
      "+.pingan.com",
      "+.alipay.com",
    ],
    "default-nameserver": [
      "223.5.5.5",
      "119.29.29.29",
    ],
    nameserver: [
      "https://dns.alidns.com/dns-query",
      "https://doh.pub/dns-query",
    ],
    "nameserver-policy": {
      "geosite:cn,private": [
        "https://dns.alidns.com/dns-query",
        "https://doh.pub/dns-query",
      ],
      "geosite:geolocation-!cn": [
        "https://dns.google/dns-query",
        "https://8.8.8.8/dns-query",
      ],
    },
  };

  config.rules = [
    "AND,((GEOSITE,tiktok),(NETWORK,UDP),(DST-PORT,443)),REJECT",
    "AND,((GEOSITE,google-gemini),(NETWORK,UDP),(DST-PORT,443)),REJECT",
    "GEOSITE,google-gemini,🚀 节点选择",
    "GEOSITE,tiktok,🚀 节点选择",
    "GEOSITE,youtube,🚀 节点选择",
    "GEOSITE,private,DIRECT",
    "GEOIP,private,DIRECT,no-resolve",
    "GEOSITE,cn,DIRECT",
    "GEOIP,CN,DIRECT",
    "MATCH,🚀 节点选择",
  ];

  return config;
}
