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

## 尚需你在本机完成

1. 本机已经按仓库说明跑着 TeslaMate 和 PostgreSQL，并且车辆授权只在 Tesla 官方页面或本机授权工具中完成。不要把账号、密码、MFA 或 Token 发给助手。
2. 生成令牌并只放在本机助手配置中，不要提交 Git，不要贴到聊天：

```bash
openssl rand -hex 24
```

3. 在支持 MCP stdio 的助手里增加本地服务。把路径和令牌换成你自己的：

```json
{
  "mcpServers": {
    "tesla-butler-readonly": {
      "command": "node",
      "args": ["/你的目录/tesla-butler/src/assistant-mcp.mjs"],
      "env": {
        "TESLA_BUTLER_ASSISTANT_TOKEN": "换成上一步生成的令牌"
      }
    }
  }
}
```

4. 需要 Node.js 22 或更新版本。在仓库目录执行 `npm ci` 后，可用下面的命令确认进程能启动；`capabilities` 不读取车辆数据：

```bash
TESLA_BUTLER_ASSISTANT_TOKEN="换成你的令牌" npm run assistant:query -- capabilities
```

5. 飞书 Worker 仍用 `npm run worker`。助手进程不要和飞书互相代替：一个负责对话查询，一个负责原来的卡片和主动推送。

授权完成、采集程序在线，新行程才会进入 TeslaMate。接口不能补录安装前的历史路线。历史充电统计和历史行程仍然是两类数据。

## 安全边界

- 服务只监听自己的标准输入输出，不打开网络端口，不创建外部账号，不发送飞书或其它外部消息。
- 查询失败只返回 `DATA_UNAVAILABLE` 或 `DATA_TIMEOUT`，不返回 SQL、连接串或令牌。
- 日志只记录查询名称和状态码，写到标准错误。标准输出只放 MCP 消息。
- 道路名可能对应家庭或公司。默认关闭；只有你在单次查询里明确传入 `place_detail=road` 才返回。

## 剩余最少信息

要在你自己的助手里看到真实数据，还差这三样，都只留在本机：

- 上面生成的本地令牌。
- TeslaMate 正在运行，且车辆授权已由你本人完成。
- 助手客户端里的 MCP 配置，其中的目录必须是这份代码所在目录。
