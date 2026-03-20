# Sing-box 与 Mitmproxy 协同抓包与路由转发指南

在复杂的网络调试场景中，我们经常需要利用 `sing-box` 的 `tun` 模式接管系统全局流量，但又只希望用 `mitmproxy` 嗅探和修改**特定域名（URL）**的流量，且抓包完毕后还要让流量继续通过 `sing-box` 的指定节点（Outbound）科学上网。

基于您当前的运行命令（`mitmweb --mode upstream:http://127.0.0.1:2080 --listen-port 8080`），这是一种非常标准且优雅的**双向代理链（Proxy Chain）**架构。以下为详细的原理解析与配置文件实现方案。

---

## 总体架构设计 (Architecture)

为了避免死循环，流量的走向必须是单向流动的闭环：

1. **App/浏览器** 发起请求 -> 被 `sing-box` 的 `tun` Inbound 透明劫持。
2. **Sing-box 路由** 嗅探到这是目标域名（如 `api.openai.com`），将其路由给**专门指向 Mitmproxy 的本地 Outbound**。
3. **Mitmproxy**（监听在 `8080`）收到请求，解密并记录/修改流量。
4. **Mitmproxy Upstream** 将流量转发回 `sing-box` 开放的本地混合端口（如 `2080`）。
5. **Sing-box 路由** 识别到从 `2080` 重新进来的流量，直接路由给**真正的代理节点 Outbound** 发往互联网。

```text
[App] 
  │ (Global Traffic)
  ▼
[sing-box IN: tun] 
  │
  ├─(Other Domains)──► [sing-box OUT: Proxy/Direct] ──► Internet
  │
  └─(Target Domain)──► [sing-box OUT: to-mitmproxy] 
                             │
                             ▼
                       [mitmproxy :8080] (解密/抓包/修改)
                             │ (--mode upstream:http://127.0.0.1:2080)
                             ▼
[sing-box IN: mixed 2080] ◄──┘
  │
  └─(Bypass Rules) ──► [sing-box OUT: Proxy Node] ──► Internet
```

---

## 具体配置指南 (Configuration)

### 1. Mitmproxy 启动命令
您当前使用的命令已经非常完美：
```bash
uv run mitmweb --mode upstream:http://127.0.0.1:2080 --listen-port 8080
```
- `--listen-port 8080`：接收从 sing-box 分流过来的特定域名流量。
- `--mode upstream:http://127.0.0.1:2080`：抓完包后，将流量原封不动地交还给 sing-box 的 2080 端口。

### 2. Sing-box 配置文件 (`config.json`)

要在 `sing-box` 中实现上述拓扑，配置需要包含以下关键部分：

#### A. Inbounds (入站)
我们需要两个入站，一个是接管系统的 `tun`，一个是接收 Mitmproxy 回传的 `mixed`。
```json
"inbounds": [
  {
    "type": "tun",
    "tag": "tun-in",
    "inet4_address": "172.19.0.1/30",
    "auto_route": true,
    "strict_route": true
  },
  {
    "type": "mixed",
    "tag": "mitm-in", // 打上 Tag，非常关键，用于防止路由死循环
    "listen": "127.0.0.1",
    "listen_port": 2080
  }
]
```

#### B. Outbounds (出站)
需要有一个指向本地 Mitmproxy 的 HTTP 出站，以及真正的互联网代理节点。
```json
"outbounds": [
  {
    "type": "vless", // 或者 shadowsocks, trojan 等真正的节点出站
    "tag": "proxy-out",
    "server": "...",
    "server_port": 443
  },
  {
    "type": "http",
    "tag": "to-mitmproxy",
    "server": "127.0.0.1",
    "server_port": 8080
  },
  {
    "type": "direct",
    "tag": "direct"
  }
]
```

#### C. Route (路由规则规则)
这是最核心的部分。必须**优先处理从 Mitmproxy 回来的流量**，然后再处理去往 Mitmproxy 的流量。

```json
"route": {
  "rules": [
    {
      "comment": "1. 从 Mitmproxy (2080) 回来的流量，强制走真正的代理节点，防止死循环",
      "inbound": ["mitm-in"],
      "outbound": "proxy-out"
    },
    {
      "comment": "2. 你想要抓包的特定域名，分流给 Mitmproxy (8080)",
      "domain": [
        "api.openai.com",
        "api.anthropic.com"
      ],
      "domain_keyword": [
        "claude"
      ],
      "outbound": "to-mitmproxy"
    },
    {
      "comment": "3. 其他流量正常走节点或直连",
      "geosite": ["cn"],
      "outbound": "direct"
    }
  ],
  "final": "proxy-out",
  "auto_detect_interface": true
}
```

---

## 避坑与注意事项 (Gotchas)

1. **死循环警告 (Infinite Loop)**
   绝对不要漏掉 `inbound: ["mitm-in"] -> outbound: proxy-out` 这条路由规则！如果漏掉，从 2080 进来的流量在匹配到目标域名时，会再次被路由给 `to-mitmproxy`，导致流量在 sing-box 和 mitmproxy 之间无限踢皮球，瞬间占满 CPU。
2. **TLS 证书信任问题**
   Mitmproxy 只能解密客户端信任其根证书的流量。如果一些系统级流量或特定包（如 Python 的 `requests` / Node.js 的 `axios`）走了 tun 被拦截到了前端，但客户端代码没有信任操作系统的根证书库，会出现 `TLS handshake failed`，遇到这种情况需要对相应的脚本指定环境变量 (如 `REQUESTS_CA_BUNDLE=~/.mitmproxy/mitmproxy-ca-cert.pem`)。
3. **域名解析 (DNS)**
   流量进入 Mitmproxy 必须带上原始的 SNI 域名。由于是配置了 upstream mode 并且走的是 HTTP 代理转发机制，DNS 解析通常会推迟到真正的远端（即 `proxy-out` 后的服务器）进行，这能极大避免本地 DNS 污染引起的连接失败。
