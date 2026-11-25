import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { assertAssistantToken } from "../src/assistant-auth.mjs";
import { createMcpSession, createLineParser, serveAssistantMcp } from "../src/assistant-mcp.mjs";
import { createAssistantService } from "../src/assistant-service.mjs";
import { createDrivingReader } from "../src/driving-read.mjs";
import { selectMainRoute } from "../src/routes.mjs";
import { calculateFuelComparisons } from "../src/comparisons.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vin = "TEST0A1B2C3D4E5F6";
const secret = "synthetic-token-should-not-leak";
const lat = "10.111111";
const lng = "20.222222";

function simulatedTrip() {
  return {
    id: 99,
    car_id: 7,
    vin,
    access_token: secret,
    segment_ids: [99],
    start_lat: Number(lat),
    start_lng: Number(lng),
    end_lat: 30.333333,
    end_lng: 40.444444,
    start_road: "模拟路甲",
    end_road: "模拟路乙",
    start_at: "2026-11-01T00:12:00Z",
    end_at: "2026-11-01T00:40:00Z",
    distance_km: 12.3,
    duration_min: 28,
    estimated_kwh: 2.1,
    drawn_kwh: 2.4,
    regenerated_kwh: 0.3,
    energy_source: "power_integration"
  };
}

function simulatedReader(overrides = {}) {
  const trip = simulatedTrip();
  return {
    collectionStatus: async () => ({
      cars: 1,
      drives: 4,
      positions: 20,
      charging_processes: 2,
      latest_drive_at: "2026-11-01T00:40:00Z",
      latest_position_at: "2026-11-01T00:40:00Z",
      vin
    }),
    latestTrip: async () => ({
      trip,
      pricingSummary: {
        cost_cny: 1.26,
        cost_complete: true,
        special_kwh: 0,
        default_kwh: 2.1,
        unpriced_kwh: 0,
        default_rates_cny_per_kwh: [0.6],
        current_default_rate_cny_per_kwh: 0.6,
        drive_ids: [99],
        vin
      },
      advice: {
        code: "smooth_trip",
        title: "模拟建议",
        detail: `参考 ${vin} 与 ${secret}，坐标 ${lat},${lng}`,
        baseline_count: 3
      }
    }),
    periodReport: async (period) => ({
      period,
      trips: {
        trip_count: 3,
        drive_ids: [1, 2, 3],
        distance_km: 30,
        duration_min: 70,
        estimated_kwh: 6,
        drawn_kwh: 7,
        regenerated_kwh: 1,
        energy_source: "power_integration",
        period_start_at: "2026-11-01T00:00:00Z",
        period_end_at: "2026-11-20T00:00:00Z",
        vin
      },
      receipts: {
        count: 1,
        amount_cny: 12,
        energy_kwh: 20,
        electricity_fee_cny: 8,
        service_fee_cny: 4,
        all_in_unit_price_cny_per_kwh: 0.6
      },
      pricingSummary: { cost_cny: 3.6, cost_complete: true, default_kwh: 6, special_kwh: 0, unpriced_kwh: 0, default_rates_cny_per_kwh: [0.6] },
      tripElectricCost: 3.6,
      comparisons: calculateFuelComparisons(30, 3.6),
      mainRoute: period === "month" ? {
        label: "模拟路甲 ↔ 模拟路乙",
        trip_count: 3,
        distance_km: 30,
        representative_drive_id: 3,
        representative_start_road: "模拟路甲",
        representative_end_road: "模拟路乙",
        start_lat: Number(lat),
        start_lng: Number(lng)
      } : undefined
    }),
    vehicleOverview: async () => ({
      vehicle: {
        model: "模拟车型",
        trim: "测试",
        state: "asleep",
        battery_level: 80,
        rated_range_km: 400,
        odometer_km: 1000,
        vin,
        updated_at: "2026-11-01T00:40:00Z"
      },
      month: { trip_count: 3, distance_km: 30, duration_min: 70 }
    }),
    recentCharging: async () => ({
      window_days: 7,
      processes: [{
        id: 8,
        vin,
        latitude: Number(lat),
        longitude: Number(lng),
        start_at: "2026-11-01T02:00:00Z",
        end_at: "2026-11-01T04:00:00Z",
        start_battery_level: 20,
        end_battery_level: 80,
        charge_energy_added: 40
      }],
      monthReceipts: { count: 1, amount_cny: 12, energy_kwh: 20, electricity_fee_cny: 8, service_fee_cny: 4, all_in_unit_price_cny_per_kwh: 0.6 }
    }),
    ...overrides
  };
}

function service() {
  return createAssistantService({ reader: simulatedReader(), collector: "simulated" });
}

function assertRedacted(payload) {
  const text = JSON.stringify(payload);
  assert.equal(text.includes(vin), false);
  assert.equal(text.includes(secret), false);
  assert.equal(text.includes(lat), false);
  assert.equal(text.includes(lng), false);
  assert.equal(text.includes("模拟路甲"), false);
  assert.equal(text.includes("start_lat"), false);
  assert.equal(text.includes("access_token"), false);
}

test("默认只读结果去掉模拟 VIN、坐标、令牌和道路名", async () => {
  const result = await service().answer({ query: "latest_trip" });
  assert.equal(result.ok, true);
  assert.equal(result.collector, "simulated");
  assert.equal(result.connected_chat, false);
  assert.equal(result.vehicle_commands, false);
  assert.equal(result.data.distance_km.kind, "actual");
  assert.equal(result.data.distance_km.value, 12.3);
  assert.equal(result.data.estimated_kwh.kind, "estimated");
  assert.equal(result.data.cost_cny.kind, "estimated");
  assert.equal(result.data.place.visibility, "hidden");
  assert.equal(result.data.advice.detail, "[redacted]");
  assert.match(result.summary_zh, /道路名已隐藏/);
  assertRedacted(result);
  const status = await service().answer({ query: "collection_status" });
  const vehicle = await service().answer({ query: "vehicle_overview" });
  const charging = await service().answer({ query: "charging_summary" });
  assert.equal(status.data.car_count.value, 1);
  assert.equal(vehicle.data.battery_level.kind, "actual");
  assert.equal(vehicle.data.battery_level.value, 80);
  assert.equal(charging.data.sessions[0].energy_kwh.value, 40);
  assert.equal(charging.data.sessions[0].latitude, undefined);
  assertRedacted(status);
  assertRedacted(vehicle);
  assertRedacted(charging);
});

test("只有显式要求时才返回模拟道路名，坐标仍然不返回", async () => {
  const result = await service().answer({ query: "period_report", period: "month", place_detail: "road" });
  assert.equal(result.data.main_route.label, "模拟路甲 ↔ 模拟路乙");
  assert.equal(result.data.comparisons.price_source.length > 0, true);
  assert.match(result.data.comparisons.effective_date, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(result.data.cost_cny.kind, "estimated");
  const text = JSON.stringify(result);
  assert.equal(text.includes(vin), false);
  assert.equal(text.includes(lat), false);
  assert.equal(text.includes("representative_drive_id"), false);
});

test("控制指令和敏感字段不会触发读取", async () => {
  let called = false;
  const guarded = createAssistantService({
    collector: "simulated",
    reader: { latestTrip: async () => { called = true; return { trip: null }; } }
  });
  const control = await guarded.answer({ query: "unlock_doors" });
  const planted = await guarded.answer({ query: "latest_trip", vin, latitude: lat });
  assert.equal(called, false);
  assert.equal(control.code, "UNSUPPORTED_CONTROL");
  assert.equal(planted.code, "UNSUPPORTED_CONTROL");
  assertRedacted(control);
  assertRedacted(planted);
});

test("周报不读取路线候选，月报复用主跑路线选择", async () => {
  const calls = [];
  const drives = [1, 2, 3].map((id) => ({
    id,
    distance_km: 10,
    start_at: "2026-11-01T00:00:00Z",
    end_at: "2026-11-01T00:20:00Z",
    start_lat: 10.111111,
    start_lng: 20.222222,
    end_lat: 10.111211,
    end_lng: 20.222322,
    start_road: "模拟路甲",
    end_road: "模拟路乙"
  }));
  const reader = createDrivingReader({
    getPeriodTrips: async (period) => ({
      drive_ids: [1],
      trip_count: 1,
      distance_km: 10,
      duration_min: 20,
      estimated_kwh: 2,
      energy_source: "power_integration"
    }),
    getReceiptTotals: async () => ({ count: 0, amount_cny: 0, energy_kwh: 0, electricity_fee_cny: 0, service_fee_cny: 0, all_in_unit_price_cny_per_kwh: null }),
    getPeriodRouteCandidates: async (period) => {
      calls.push(period);
      return drives;
    },
    getElectricityCostSummary: async (ids) => {
      assert.deepEqual(ids, [1]);
      return { cost_cny: 1.2, cost_complete: true, default_kwh: 2, special_kwh: 0, unpriced_kwh: 0, default_rates_cny_per_kwh: [0.6] };
    },
    calculateFuelComparisons,
    selectMainRoute
  });
  const week = await reader.periodReport("week");
  const month = await reader.periodReport("month");
  assert.equal(week.mainRoute, undefined);
  assert.deepEqual(calls, ["month"]);
  assert.equal(month.mainRoute.trip_count, 3);
  assert.equal(month.tripElectricCost, 1.2);
  const presented = await createAssistantService({ reader, collector: "simulated" }).answer({ query: "period_report", period: "month" });
  assert.equal(presented.data.main_route.status, "selected");
  assert.equal(presented.data.main_route.label, undefined);
  assertRedacted(presented);
});

test("MCP 初始化、工具列表和模拟调用只走只读工具", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let raw = "";
  output.setEncoding("utf8");
  output.on("data", (chunk) => { raw += chunk; });
  serveAssistantMcp({ input, output, service: service() });
  const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "simulated", version: "0" } } };
  const list = { jsonrpc: "2.0", id: 2, method: "tools/list" };
  const call = { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "read_latest_trip", arguments: { place_detail: "hidden", vin } } };
  input.write(`${JSON.stringify(init)}\n${JSON.stringify(list)}\n`);
  input.end(`${JSON.stringify(call)}\n`);
  await once(output, "finish");
  const messages = raw.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(messages[0].result.protocolVersion, "2025-06-18");
  assert.equal(messages[0].result.serverInfo.name, "tesla-butler-readonly");
  assert.equal(messages[1].result.tools.every((item) => item.annotations.readOnlyHint === true), true);
  assert.equal(messages[1].result.tools.some((item) => /unlock|command|honk/i.test(item.name)), false);
  const body = messages[2].result.structuredContent;
  assert.equal(body.code, "UNSUPPORTED_CONTROL");
  assert.equal(raw.includes(vin), false);
  assert.equal(raw.includes(secret), false);
});

test("未初始化时不列出工具，分行到达的 JSON 仍可解析", async () => {
  const session = createMcpSession(service());
  const early = await session.handle({ jsonrpc: "2.0", id: 7, method: "tools/list" });
  assert.equal(early.error.code, -32002);
  const lines = [];
  const parse = createLineParser((line) => lines.push(line));
  parse('{"jsonrpc":"2.0","id":1,');
  parse(' "method":"ping"}\n');
  assert.equal(JSON.parse(lines[0]).method, "ping");
});

test("缺少本地令牌时进程拒绝启动且不输出数据", async () => {
  assert.throws(() => assertAssistantToken({ TESLA_BUTLER_ASSISTANT_TOKEN: "too-short" }), /invalid/);
  const child = spawn(process.execPath, ["src/assistant-mcp.mjs"], {
    cwd: root,
    env: { PATH: process.env.PATH || "" }
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const [code] = await once(child, "exit");
  assert.equal(code, 1);
  assert.equal(stdout, "");
  assert.match(stderr, /拒绝启动/);
  assert.doesNotMatch(stderr, /TESLA_BUTLER_ASSISTANT_TOKEN=/);
});
