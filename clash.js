// 所有协议都保留，仅屏蔽 香港 / 韩国 节点及订阅信息伪节点，其余所有国家全部放行
// 只有一个分组：自动测速（600秒间隔 + 200ms容差，HTTPS 测速防 CF 节点探测拦截）
// 保留 IPv6 + 银行 App 绕过 Fake-IP + TikTok/Gemini 屏蔽 QUIC 防卡顿 + YouTube/GitHub/英语播客加速
function main(config) {
  const blockRe = /香港|\bHK\b|Hong\s*Kong|🇭🇰|韩国|韓國|\bKR\b|Korea|Seoul|🇰🇷|剩余|流量|到期|过期|重置|官网|网址|套餐|通知|群|TG|Telegram|Traffic|Expire|Reset/i;

  const kept = (config.proxies || []).filter((p) => !blockRe.test(p.name));
  config.proxies = kept;

  config["proxy-groups"] = kept.length
    ? [{
        name: "🚀 节点选择",
        type: "url-test",
        url: "https://cp.cloudflare.com/generate_204",
        interval: 600,
        tolerance: 200,
        timeout: 3000,
        proxies: kept.map((p) => p.name),
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
        "8.8.8.8",
      ],
    },
  };

  config.rules = [
    "AND,((GEOSITE,tiktok),(NETWORK,UDP),(DST-PORT,443)),REJECT",
    "AND,((GEOSITE,google-gemini),(NETWORK,UDP),(DST-PORT,443)),REJECT",
    "GEOSITE,bbc,🚀 节点选择",
    "DOMAIN-SUFFIX,pocketcasts.com,🚀 节点选择",
    "GEOSITE,github,🚀 节点选择",
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
