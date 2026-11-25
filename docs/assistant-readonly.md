# 只读助手接入

飞书仍然负责收发卡片。助手入口只读取本机已经整理好的行程、里程、能耗和充电统计，通过 MCP 的标准输入输出提供给支持该协议的助手。它不解锁、不启动、不鸣笛，也不调用车辆命令。

## 已经完成的代码

- 行程、周期账单、车辆概览的取数集中在 `src/driving-read.mjs`。飞书卡片继续用这组结果画地图和发消息。
- `src/assistant-service.mjs` 把上述结果整理成固定 JSON：实测里程和时长标为 `actual`，功率积分或电价分摊标为 `estimated`，缺失标为 `unknown`。油车对比保留油价来源和生效日期。
- `src/assistant-mcp.mjs` 是本地 MCP stdio 服务，工具均标记为只读。`npm run assistant` 会启动它。
- `src/assistant-cli.mjs` 用同一套查询打一行 JSON，便于在本机自检。`npm run assistant:query -- capabilities`。
- 默认去掉坐标、VIN、令牌和道路名。只有查询参数 `place_detail=road` 时才返回道路名，坐标和 VIN 仍然不返回。
- 启动前必须有本机环境变量 `TESLA_BUTLER_ASSISTANT_TOKEN`。令牌只存在于你的进程环境里，服务不会把它写进日志。
- 自动化测试使用模拟行程，不连接 TeslaMate，也不向车辆或飞书发任何内容。

这些代码不会自动出现在某一次云端聊天里。助手只有在你自己的客户端配置了下面的进程后，才会读到数据。

## 工具

| 工具 | 作用 |
| :--- | :--- |
| `read_driving_capabilities` | 说明可读范围和脱敏规则 |
| `read_collection_status` | 本地库有多少车、行程和充电记录 |
| `read_latest_trip` | 最近一段完整行程 |
| `read_period_report` | `week`、`month`、`previous_week`、`previous_month` |
| `read_vehicle_overview` | 采集库里的最近车辆状态和本月里程 |
| `read_charging_summary` | 近 7 天已结束充电，以及本月已确认账单 |

没有车辆控制工具。传入解锁、启动、鸣笛、VIN、坐标或令牌字段时，接口直接拒绝，不会去读数据库。

## 从零安装时什么是必须的

当前 Mac 上还没有任何采集程序。下面按代码和官方说明区分，不把“已经部署好”当作前提。

| 组件 | 要不要 | 依据 |
| :--- | :--- | :--- |
| Docker Desktop | 要。Apple Silicon 和 Intel 都使用对应的 Mac 安装包 | [Docker Desktop for Mac](https://docs.docker.com/desktop/setup/install/mac-install/) 分 Apple silicon 与 Intel 两套。`docker version` 的 `OS/Arch` 会显示 `darwin/arm64` 或 `darwin/amd64` |
| TeslaMate | 要，但它是第三方采集程序，不是本项目写的采车代码 | 本仓库查询只读它的库。`src/teslamate.mjs` 通过 `docker compose exec database psql` 读 `drives`、`positions`、`charging_processes`、`cars`。镜像固定为 `teslamate/teslamate:4.1.1`，Docker Hub 上该标签同时有 `arm64` 和 `amd64`。官方说明：[Docker install](https://docs.teslamate.org/docs/installation/docker) |
| PostgreSQL | 要，但不要在 Mac 上另装一个数据库 | 它是同一份 `infra/teslamate/compose.yaml` 里的 `database` 服务，镜像 `postgres:18-trixie`，同样有 `arm64` 和 `amd64`。该服务没有把端口开到 Mac 上 |
| MQTT | 采集栈要有 | TeslaMate 依赖它。只读查询代码不订阅 MQTT。飞书的即时充电和行程边界才会用它 |
| Grafana | 会随采集栈启动 | 给 TeslaMate 自己看图。只读助手不读它 |
| Node.js 22 或更新 | 要，用来跑本项目 | `package.json` 的 `engines.node`。它不负责向车辆采集 |
| 飞书、Chrome、Xcode | 不要，除非你还要原来的飞书卡片、地图或账单识别 | 只读数字查询不经过这些组件 |
| 本聊天自动接入 | 做不到 | 入口只有 MCP 标准输入输出。云端聊天不会因为 Mac 装好软件就连上。必须由**和数据在同一台 Mac 上**、并且支持 MCP stdio 的客户端启动 `src/assistant-mcp.mjs` |

本项目没有自己的车辆采集器。Fleet API / Fleet Telemetry 只是以后的迁移方向，不是这条安装路径。

## 正确顺序

现在只做第 1 步。不要启动容器，不要登录 Tesla，不要把账号、密码、MFA 或 Token 贴到聊天。

1. 在 Mac 的“终端”运行 `docker version`。同时看到 Client 和 Server，并且 Server 没有报错，才说明 Docker 已安装且引擎在运行。`OS/Arch` 用来确认是 Apple Silicon（`arm64`）还是 Intel（`amd64`）。命令不存在，就到上面的 Docker Desktop 页面下载对应芯片的安装包，打开 Docker.app，等它显示正在运行后再查一次。
2. 安装 [Node.js 22 或更新版本](https://nodejs.org/)。这只为本项目的程序服务。
3. 取得**这一份 fork 的助手分支**。只读入口还在拉取请求分支 `cursor/readonly-assistant-mcp-b39a`，没有合并，上游仓库 `manwithshit/tesla-butler` 的 `main` 里没有这段代码：

```bash
git clone https://github.com/wnswtc-ship-it/tesla-butler.git
cd tesla-butler
git checkout cursor/readonly-assistant-mcp-b39a
npm ci
```

4. 生成本地令牌并只留在本机。不要提交，不要贴到聊天：

```bash
openssl rand -hex 24
```

5. 确认助手进程本身能启动。这条命令不读车辆，也不会把本聊天连上：

```bash
TESLA_BUTLER_ASSISTANT_TOKEN="换成你的令牌" npm run assistant:query -- capabilities
```

6. 需要真实行程时，再在仓库目录启动采集栈。这一步会下载 TeslaMate、它自带的 PostgreSQL、MQTT 和 Grafana。密钥由脚本写进本机 `infra/teslamate/.env`，不要打开或转发这个文件：

```bash
./scripts/init-teslamate-env.sh
docker compose --env-file infra/teslamate/.env \
  -f infra/teslamate/compose.yaml up -d
```

然后只在自己电脑的 http://127.0.0.1:4000 完成 TeslaMate 登录。账号、MFA 和 Token 只留在那个页面。TeslaMate 只能记下启动之后、电脑醒着且能上网时的新行程，不能补录更早的路线。

7. 最后才把 MCP 配进**这台 Mac 上**受支持的客户端。示例：

```json
{
  "mcpServers": {
    "tesla-butler-readonly": {
      "command": "node",
      "args": ["/你的目录/tesla-butler/src/assistant-mcp.mjs"],
      "env": {
        "TESLA_BUTLER_ASSISTANT_TOKEN": "换成你的令牌"
      }
    }
  }
}
```

没有第 7 步，任何云端对话都读不到这台 Mac 上的数据。飞书如果以后还要用，再按 [飞书连接教程](../infra/feishu/README.md) 另做；它不是只读助手的前提。

## 安全边界

- 服务只监听自己的标准输入输出，不打开网络端口，不创建外部账号，不发送飞书或其它外部消息。
- 查询失败只返回 `DATA_UNAVAILABLE` 或 `DATA_TIMEOUT`，不返回 SQL、连接串或令牌。
- 日志只记录查询名称和状态码，写到标准错误。标准输出只放 MCP 消息。
- 道路名可能对应家庭或公司。默认关闭；只有你在单次查询里明确传入 `place_detail=road` 才返回。

## 剩余最少信息

现在还没有采集程序。下一步只在 Mac 终端运行 `docker version`，看有没有 Client 和 Server，以及 `OS/Arch` 是 `darwin/arm64` 还是 `darwin/amd64`。不要贴令牌或车辆凭据。

之后要看到真实行程，仍须按上面的顺序：Node.js、检出本拉取请求的分支、本机令牌、启动 Docker 里的 TeslaMate 采集栈、由你本人在本机页面授权，以及一台同机的 MCP stdio 客户端。缺最后一项时，这次云端聊天仍然连不上。
