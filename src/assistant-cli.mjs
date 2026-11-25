import { pathToFileURL } from "node:url";
import { assertAssistantToken } from "./assistant-auth.mjs";
import { assistantQueries, createAssistantService } from "./assistant-service.mjs";
import { createDrivingReader } from "./driving-read.mjs";

function usage() {
  process.stderr.write("用法：node src/assistant-cli.mjs <capabilities|collection_status|latest_trip|period_report|vehicle_overview|charging_summary> [--period week|month|previous_week|previous_month] [--place-detail hidden|road]\n");
}

function option(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

export async function runAssistantCli(argv = process.argv.slice(2), env = process.env) {
  assertAssistantToken(env);
  const args = argv.filter((item) => item !== "--");
  const query = args.find((item) => !item.startsWith("--") && assistantQueries.includes(item));
  if (!query) {
    usage();
    return 2;
  }
  const service = createAssistantService({
    collector: "teslamate",
    reader: createDrivingReader({
      log: (message) => process.stderr.write(`[${new Date().toISOString()}] ${message}\n`)
    })
  });
  const result = await service.answer({
    query,
    period: option(args, "--period"),
    place_detail: option(args, "--place-detail")
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return result.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runAssistantCli().then((code) => {
    if (code) process.exitCode = code;
  }).catch((error) => {
    if (error?.code === "ASSISTANT_TOKEN_INVALID") {
      process.stderr.write("拒绝运行：缺少有效的 TESLA_BUTLER_ASSISTANT_TOKEN。不要把令牌写入仓库、日志或聊天。\n");
    } else {
      process.stderr.write("只读查询没有完成。没有向车辆发送指令。\n");
    }
    process.exitCode = 1;
  });
}
