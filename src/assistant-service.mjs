import {
  presentCapabilities,
  presentCharging,
  presentCollection,
  presentFailure,
  presentLatestTrip,
  presentPeriod,
  presentVehicle
} from "./assistant-present.mjs";
import { drivingPeriods } from "./driving-read.mjs";

export const assistantQueries = Object.freeze([
  "capabilities",
  "collection_status",
  "latest_trip",
  "period_report",
  "vehicle_overview",
  "charging_summary"
]);

const querySet = new Set(assistantQueries);
const periodSet = new Set(drivingPeriods);
const controlPattern = /(unlock|honk|flash|remote[_-]?start|vehicle[_-]?cmd|wake|trunk|frunk|sentry|valet|charge[_-]?start|door[_-]?lock|window|climate|navigate|horn)/i;
const sensitiveKey = /vin|token|secret|password|latitude|longitude|^lat$|^lng$|gps/i;

function timeoutCode(error) {
  return ["DB_DEADLINE", "DB_PROCESS_TIMEOUT", "DB_STATEMENT_TIMEOUT", "DB_ABORTED"].includes(error?.code);
}

export function isRejectedAssistantInput(input) {
  if (controlPattern.test(String(input?.query || ""))) return true;
  if (controlPattern.test(String(input?.place_detail || ""))) return true;
  return Object.keys(input || {}).some((key) => controlPattern.test(key) || sensitiveKey.test(key));
}

function failureCode(error) {
  if (error?.code === "INVALID_ARGUMENT") return "INVALID_ARGUMENT";
  if (timeoutCode(error)) return "DATA_TIMEOUT";
  return "DATA_UNAVAILABLE";
}

const failureText = {
  UNSUPPORTED_CONTROL: "只读接口不接受车辆解锁、启动、鸣笛或其他控制指令。",
  UNSUPPORTED_QUERY: "不支持这个查询。可用查询：capabilities、collection_status、latest_trip、period_report、vehicle_overview、charging_summary。",
  INVALID_ARGUMENT: "参数不正确。period 只能是 week、month、previous_week、previous_month；place_detail 只能是 hidden 或 road。",
  DATA_TIMEOUT: "读取本地数据超时。没有向车辆发送指令。",
  DATA_UNAVAILABLE: "没有读到本地行车数据。请确认 Docker 里的 TeslaMate 数据库容器正在运行。不需要单独安装 PostgreSQL。没有向车辆发送指令。"
};

export function createAssistantService({ reader, collector = "teslamate" } = {}) {
  async function answer(input = {}) {
    const query = String(input.query || "");
    const placeDetail = input.place_detail || "hidden";
    const options = { collector, placeDetail: placeDetail === "road" ? "road" : "hidden" };
    if (isRejectedAssistantInput(input)) return presentFailure("UNSUPPORTED_CONTROL", failureText.UNSUPPORTED_CONTROL);
    if (!querySet.has(query)) return presentFailure("UNSUPPORTED_QUERY", failureText.UNSUPPORTED_QUERY);
    if (placeDetail !== "hidden" && placeDetail !== "road") {
      return presentFailure("INVALID_ARGUMENT", failureText.INVALID_ARGUMENT);
    }
    if (query === "capabilities") return presentCapabilities(options);
    try {
      if (query === "collection_status") return presentCollection(await reader.collectionStatus(), options);
      if (query === "latest_trip") return presentLatestTrip(await reader.latestTrip(), options);
      if (query === "vehicle_overview") return presentVehicle(await reader.vehicleOverview(), options);
      if (query === "charging_summary") return presentCharging(await reader.recentCharging(), options);
      if (!periodSet.has(input.period)) return presentFailure("INVALID_ARGUMENT", failureText.INVALID_ARGUMENT);
      return presentPeriod(await reader.periodReport(input.period), options);
    } catch (error) {
      const code = failureCode(error);
      return presentFailure(code, failureText[code]);
    }
  }

  return { answer };
}
