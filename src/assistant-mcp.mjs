import { pathToFileURL } from "node:url";
import { assertAssistantToken } from "./assistant-auth.mjs";
import { assistantQueries, createAssistantService, isRejectedAssistantInput } from "./assistant-service.mjs";
import { createDrivingReader } from "./driving-read.mjs";

const protocolVersions = new Set(["2024-11-05", "2025-03-26", "2025-06-18"]);
const serverInfo = { name: "tesla-butler-readonly", version: "0.1.0" };

const queryByTool = Object.freeze({
  read_driving_capabilities: "capabilities",
  read_collection_status: "collection_status",
  read_latest_trip: "latest_trip",
  read_period_report: "period_report",
  read_vehicle_overview: "vehicle_overview",
  read_charging_summary: "charging_summary"
});

function tool(name, description, properties, required = []) {
  return {
    name,
    description,
    inputSchema: {
      type: "object",
      properties,
      required,
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  };
}

const placeDetailSchema = { type: "string", enum: ["hidden", "road"], description: "默认 hidden，不返回道路名。road 仍不返回坐标和 VIN。" };
const periodSchema = { type: "string", enum: ["week", "month", "previous_week", "previous_month"] };

export const assistantTools = Object.freeze([
  tool("read_driving_capabilities", "说明本机只读行车接口能读什么、默认隐藏什么，以及它不会控制车辆。", {}),
  tool("read_collection_status", "读取 TeslaMate 本地库的车辆、行程、充电记录数量和最近时间。不返回坐标或 VIN。", {}),
  tool("read_latest_trip", "整理最近一段完整行程的里程、时长、估算能耗和估算电费。", { place_detail: placeDetailSchema }),
  tool("read_period_report", "整理一周、本月、上周或上月的里程、能耗、行程电费、已确认账单和油车对比。", {
    period: periodSchema,
    place_detail: placeDetailSchema
  }, ["period"]),
  tool("read_vehicle_overview", "读取采集库中的最近车辆状态和本月里程。这不是向车辆发出的指令。", {}),
  tool("read_charging_summary", "整理近 7 天已结束充电的电量和本月已确认账单。不返回充电地点。", {})
]);

function rpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

function toolResult(payload, isError = false) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
    isError
  };
}

export function createMcpSession(service) {
  const state = { initialized: false };
  return {
    async handle(message) {
      if (!message || message.jsonrpc !== "2.0" || Array.isArray(message)) {
        return rpcError(message?.id ?? null, -32600, "Invalid Request");
      }
      if (message.id === undefined || message.id === null) {
        if (message.method === "notifications/initialized") state.initialized = true;
        return null;
      }
      if (message.method === "initialize") {
        const requested = message.params?.protocolVersion;
        state.initialized = true;
        return rpcResult(message.id, {
          protocolVersion: protocolVersions.has(requested) ? requested : "2025-06-18",
          capabilities: { tools: { listChanged: false } },
          serverInfo,
          instructions: "只读整理本机已经采集的行程、里程、能耗和充电统计。不提供解锁、启动、鸣笛或任何车辆控制。坐标和 VIN 默认不返回。配置本服务不会自动把它连到当前聊天。"
        });
      }
      if (message.method === "ping") return rpcResult(message.id, {});
      if (!state.initialized) return rpcError(message.id, -32002, "Server not initialized");
      if (message.method === "tools/list") return rpcResult(message.id, { tools: assistantTools });
      if (message.method !== "tools/call") return rpcError(message.id, -32601, "Method not found");

      const name = message.params?.name;
      const args = message.params?.arguments && typeof message.params.arguments === "object"
        ? message.params.arguments
        : {};
      if (isRejectedAssistantInput(args)) {
        const payload = { ok: false, code: "UNSUPPORTED_CONTROL", connected_chat: false, vehicle_commands: false, summary_zh: "只读接口不接受车辆控制，也不接收 VIN、坐标或令牌。", data: null };
        return rpcResult(message.id, toolResult(payload, true));
      }
      if (!Object.hasOwn(queryByTool, name)) {
        const denied = /unlock|honk|start|wake|horn|trunk|command/i.test(String(name || ""));
        const payload = denied
          ? { ok: false, code: "UNSUPPORTED_CONTROL", summary_zh: "只读接口不接受车辆控制。", data: null }
          : { ok: false, code: "UNSUPPORTED_QUERY", summary_zh: "没有这个只读查询。", data: null };
        return rpcResult(message.id, toolResult(payload, true));
      }
      const payload = await service.answer({
        query: queryByTool[name],
        period: args.period,
        place_detail: args.place_detail
      });
      const safeQuery = assistantQueries.includes(payload.query) ? payload.query : "rejected";
      process.stderr.write(`[${new Date().toISOString()}] assistant_query query=${safeQuery} status=${payload.ok ? "ok" : "error"} code=${payload.code || "OK"}\n`);
      return rpcResult(message.id, toolResult(payload, payload.ok !== true));
    }
  };
}

export function createLineParser(onLine, maxBytes = 64 * 1024) {
  let buffer = "";
  return (chunk) => {
    buffer += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    if (Buffer.byteLength(buffer) > maxBytes) {
      buffer = "";
      throw Object.assign(new Error("message too large"), { code: "MESSAGE_TOO_LARGE" });
    }
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/, "").trim();
      buffer = buffer.slice(newline + 1);
      if (line) onLine(line);
      newline = buffer.indexOf("\n");
    }
  };
}

export function isDirectRun(metaUrl = import.meta.url, argv1 = process.argv[1]) {
  if (!argv1) return false;
  return metaUrl === pathToFileURL(argv1).href;
}

export async function serveAssistantMcp({ input, output, service }) {
  const session = createMcpSession(service);
  let pending = 0;
  let ended = false;
  const write = (message) => {
    if (message) output.write(`${JSON.stringify(message)}\n`);
  };
  const finish = () => {
    if (ended && pending === 0) output.end();
  };
  const parse = createLineParser((line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      write(rpcError(null, -32700, "Parse error"));
      return;
    }
    pending += 1;
    Promise.resolve(session.handle(message)).then(write).catch(() => {
      write(rpcError(message?.id ?? null, -32603, "Internal error"));
    }).finally(() => {
      pending -= 1;
      finish();
    });
  });
  input.on("data", (chunk) => {
    try {
      parse(chunk);
    } catch {
      write(rpcError(null, -32600, "Invalid Request"));
    }
  });
  input.on("end", () => {
    ended = true;
    finish();
  });
}

function refuseStart() {
  process.stderr.write("拒绝启动：请在本机环境变量 TESLA_BUTLER_ASSISTANT_TOKEN 设置 24 到 128 位字母、数字、下划线或连字符。不要把令牌写入仓库、日志或聊天。\n");
  process.exit(1);
}

if (isDirectRun()) {
  try {
    assertAssistantToken();
  } catch {
    refuseStart();
  }
  const service = createAssistantService({
    collector: "teslamate",
    reader: createDrivingReader({
      log: (message) => process.stderr.write(`[${new Date().toISOString()}] ${message}\n`)
    })
  });
  serveAssistantMcp({ input: process.stdin, output: process.stdout, service });
}
