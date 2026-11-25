const droppedKeys = new Set([
  "vin", "vehicle_id", "vehicleid", "latitude", "longitude", "lat", "lng",
  "gps", "token", "secret", "password", "authorization", "access_token",
  "refresh_token", "car_id", "start_lat", "start_lng", "end_lat", "end_lng",
  "segment_ids", "drive_ids", "polyline", "positions", "route_points",
  "image_key", "representative_drive_id", "id"
]);

const roadKeys = new Set([
  "start_road", "end_road", "representative_start_road", "representative_end_road", "label"
]);

function metric(value, kind, extra = {}) {
  const numeric = value === null || value === undefined || value === "" ? null : Number(value);
  const known = numeric !== null && Number.isFinite(numeric);
  return { value: known ? numeric : null, kind: known ? kind : "unknown", ...extra };
}

function scrubString(value) {
  const text = String(value)
    .replace(/[A-Za-z0-9_-]{24,}/g, (match) => /token|secret|password/i.test(match) ? "[redacted]" : match);
  if (/\b[A-HJ-NPR-Z0-9]{17}\b/.test(text)) return "[redacted]";
  if (/-?\d{1,3}\.\d{4,}/.test(text)) return "[redacted]";
  return text;
}

export function scrubDeep(value, { placeDetail = "hidden" } = {}) {
  if (Array.isArray(value)) return value.map((item) => scrubDeep(item, { placeDetail }));
  if (!value || typeof value !== "object") return typeof value === "string" ? scrubString(value) : value;
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    const normalized = key.toLowerCase();
    if (droppedKeys.has(normalized)) continue;
    if (placeDetail !== "road" && roadKeys.has(normalized)) continue;
    output[key] = scrubDeep(item, { placeDetail });
  }
  return output;
}

function stamp(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "时间未知";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).format(date);
}

function energyMethod(source) {
  if (source === "power_integration") return "功率采样积分估算";
  if (source === "range_efficiency") return "续航差与效率估算";
  if (source === "mixed") return "混合估算";
  return null;
}

function energyKind(source) {
  return energyMethod(source) ? "estimated" : "unknown";
}

function money(value) {
  const number = Number(value);
  return Number.isFinite(number) ? `¥${number.toFixed(2)}` : "未知";
}

function envelope(query, data, summary, options) {
  return scrubDeep({
    ok: true,
    query,
    collector: options.collector,
    connected_chat: false,
    vehicle_commands: false,
    chat_delivery: "none",
    redaction: {
      coordinates: "removed",
      vin: "removed",
      place_names: options.placeDetail === "road" ? "road_names_included" : "hidden"
    },
    summary_zh: summary,
    data
  }, { placeDetail: options.placeDetail });
}

export function presentFailure(code, summary) {
  return scrubDeep({
    ok: false,
    code,
    connected_chat: false,
    vehicle_commands: false,
    chat_delivery: "none",
    summary_zh: summary,
    data: null
  });
}

function presentPricing(pricing) {
  if (!pricing) return null;
  return {
    cost_cny: metric(pricing.cost_cny, "estimated", { currency: "CNY" }),
    special_kwh: metric(pricing.special_kwh, "estimated", { unit: "kWh" }),
    default_kwh: metric(pricing.default_kwh, "estimated", { unit: "kWh" }),
    unpriced_kwh: metric(pricing.unpriced_kwh, "estimated", { unit: "kWh" }),
    default_rates_cny_per_kwh: Array.isArray(pricing.default_rates_cny_per_kwh)
      ? pricing.default_rates_cny_per_kwh.filter((rate) => Number.isFinite(Number(rate))).map(Number)
      : [],
    current_default_rate_cny_per_kwh: Number.isFinite(Number(pricing.current_default_rate_cny_per_kwh))
      ? Number(pricing.current_default_rate_cny_per_kwh)
      : null,
    unsupported_multi_car: Boolean(pricing.unsupported_multi_car),
    cost_complete: pricing.cost_complete === true
  };
}

function presentReceipts(receipts = {}) {
  return {
    count: metric(receipts.count || 0, "actual", { note: "已确认账单笔数" }),
    amount_cny: metric(receipts.amount_cny || 0, "actual", { currency: "CNY", note: "已确认账单金额" }),
    energy_kwh: metric(receipts.energy_kwh || 0, "actual", { unit: "kWh", note: "已确认账单电量" }),
    electricity_fee_cny: metric(receipts.electricity_fee_cny || 0, "actual", { currency: "CNY" }),
    service_fee_cny: metric(receipts.service_fee_cny || 0, "actual", { currency: "CNY" }),
    all_in_unit_price_cny_per_kwh: metric(receipts.all_in_unit_price_cny_per_kwh, "estimated", { currency: "CNY", unit: "kWh" })
  };
}

function presentComparisons(comparisons) {
  if (!comparisons) return null;
  return {
    price_basis: comparisons.price_basis || null,
    price_scope: comparisons.price_scope || null,
    price_source: comparisons.price_source || null,
    effective_date: comparisons.effective_date || null,
    is_current_day: comparisons.is_current_day === true,
    items: (comparisons.items || []).map((item) => ({
      name: item.name,
      model_spec: item.model_spec,
      consumption_l_per_100km: metric(item.consumption, "estimated", { source: item.source || null, grade: item.grade || null }),
      liters: metric(item.liters, "estimated", { unit: "L" }),
      cost_cny: metric(item.cost_cny, "estimated", { currency: "CNY" }),
      saving_cny: metric(item.saving_cny, "estimated", { currency: "CNY" })
    }))
  };
}

function placeText(placeDetail, startRoad, endRoad) {
  if (placeDetail === "road") return `从 ${startRoad || "起点道路未知"} 到 ${endRoad || "终点道路未知"}`;
  return "道路名已隐藏";
}

export function presentCapabilities(options) {
  const data = {
    transport: "mcp-stdio",
    writes: false,
    vehicle_commands: false,
    queries: [
      "capabilities",
      "collection_status",
      "latest_trip",
      "period_report",
      "vehicle_overview",
      "charging_summary"
    ],
    periods: ["week", "month", "previous_week", "previous_month"],
    place_detail: ["hidden", "road"],
    redaction_defaults: { coordinates: "removed", vin: "removed", place_names: "hidden" }
  };
  return envelope("capabilities", data,
    "这是本机只读行车接口，供支持 MCP 标准输入输出的助手连接。它整理已经采集的行程、里程、能耗和充电统计，不解锁、不启动、不鸣笛，也不代替飞书收发。坐标和 VIN 默认不返回。把本服务写进代码，并不等于它已经连上某一个云端聊天。",
    options);
}

export function presentCollection(status, options) {
  const data = {
    car_count: metric(status?.cars, "actual"),
    drive_count: metric(status?.drives, "actual"),
    position_sample_count: metric(status?.positions, "actual"),
    charging_process_count: metric(status?.charging_processes, "actual"),
    latest_drive_at: status?.latest_drive_at || null,
    latest_sample_at: status?.latest_position_at || null
  };
  const summary = `本地采集库现有 ${data.car_count.value ?? "未知"} 辆车、${data.drive_count.value ?? "未知"} 段驾驶记录、${data.charging_process_count.value ?? "未知"} 段充电记录。最近驾驶结束于 ${stamp(data.latest_drive_at)}。这只说明库里有记录。`;
  return envelope("collection_status", data, summary, options);
}

export function presentLatestTrip(facts, options) {
  const trip = facts?.trip;
  if (!trip) {
    return envelope("latest_trip", { trip: null },
      "还没有可读的完整行程。只有 TeslaMate 在车辆行驶时持续运行，新行程才会被记下；它不能补录安装前或离线期间的轨迹。",
      options);
  }
  const pricing = presentPricing(facts.pricingSummary);
  const method = energyMethod(trip.energy_source);
  const energy = metric(trip.estimated_kwh, energyKind(trip.energy_source), { unit: "kWh", method: method || "unavailable" });
  const cost = pricing?.cost_cny || metric(null, "unknown", { currency: "CNY" });
  const data = {
    started_at: trip.start_at || null,
    ended_at: trip.end_at || null,
    distance_km: metric(trip.distance_km, "actual", { unit: "km" }),
    duration_min: metric(trip.duration_min, "actual", { unit: "min" }),
    estimated_kwh: energy,
    drawn_kwh: metric(trip.drawn_kwh, energyKind(trip.energy_source), { unit: "kWh" }),
    regenerated_kwh: metric(trip.regenerated_kwh, energyKind(trip.energy_source), { unit: "kWh" }),
    cost_cny: cost,
    pricing,
    place: {
      visibility: options.placeDetail === "road" ? "road" : "hidden",
      start_road: options.placeDetail === "road" ? trip.start_road || null : null,
      end_road: options.placeDetail === "road" ? trip.end_road || null : null
    },
    advice: facts.advice?.title ? {
      code: facts.advice.code || null,
      title: facts.advice.title,
      detail: facts.advice.detail || null,
      baseline_count: metric(facts.advice.baseline_count, "actual")
    } : null
  };
  const summary = `最近一段行程 ${stamp(trip.start_at)} 至 ${stamp(trip.end_at)}，行驶 ${data.distance_km.value ?? "未知"} km，用时 ${data.duration_min.value ?? "未知"} 分钟。耗电 ${energy.value ?? "未知"} 度（${method || "未知"}），电费 ${money(cost.value)}（估算或未知）。${placeText(options.placeDetail, trip.start_road, trip.end_road)}。`;
  return envelope("latest_trip", data, summary, options);
}

const periodLabels = {
  week: "本周截至当前",
  month: "本月截至当前",
  previous_week: "上周完整周期",
  previous_month: "上月完整周期"
};

export function presentPeriod(facts, options) {
  const trips = facts?.trips || {};
  const monthly = facts.period === "month" || facts.period === "previous_month";
  const comparisons = presentComparisons(facts.comparisons);
  const mainRoute = !monthly ? { status: "not_applicable" }
    : facts.mainRoute ? {
      status: "selected",
      trip_count: metric(facts.mainRoute.trip_count, "actual"),
      distance_km: metric(facts.mainRoute.distance_km, "actual", { unit: "km" }),
      place_visibility: options.placeDetail === "road" ? "road" : "hidden",
      label: options.placeDetail === "road" ? facts.mainRoute.label || null : null
    } : { status: "none" };
  const energy = metric(trips.estimated_kwh, energyKind(trips.energy_source), {
    unit: "kWh",
    method: energyMethod(trips.energy_source) || "unavailable"
  });
  const data = {
    period: facts.period,
    period_label: periodLabels[facts.period] || facts.period,
    started_at: trips.period_start_at || null,
    ended_at: trips.period_end_at || null,
    trip_count: metric(trips.trip_count, "actual"),
    distance_km: metric(trips.distance_km, "actual", { unit: "km" }),
    duration_min: metric(trips.duration_min, "actual", { unit: "min" }),
    estimated_kwh: energy,
    drawn_kwh: metric(trips.drawn_kwh, energyKind(trips.energy_source), { unit: "kWh" }),
    regenerated_kwh: metric(trips.regenerated_kwh, energyKind(trips.energy_source), { unit: "kWh" }),
    cost_cny: metric(facts.tripElectricCost, "estimated", { currency: "CNY" }),
    pricing: presentPricing(facts.pricingSummary),
    receipts: presentReceipts(facts.receipts),
    comparisons,
    main_route: mainRoute
  };
  const priceNote = comparisons?.price_source
    ? `油车对比使用${comparisons.price_source}，生效日期 ${comparisons.effective_date || "未知"}，结果是估算。`
    : "油车对比价格来源未知。";
  const routeNote = mainRoute.status === "selected"
    ? (options.placeDetail === "road" ? `主跑路线 ${mainRoute.label}。` : "月报主跑路线已算出，道路名已隐藏。")
    : mainRoute.status === "none" ? "本周期没有重复 3 次以上的主跑路线。" : "";
  const summary = `${data.period_label}：${data.trip_count.value ?? 0} 段行程，累计 ${data.distance_km.value ?? 0} km，耗电 ${energy.value ?? "未知"} 度，行程电费 ${money(data.cost_cny.value)}。${priceNote}${routeNote}`;
  return envelope("period_report", data, summary, options);
}

export function presentVehicle(facts, options) {
  const vehicle = facts?.vehicle || {};
  const month = facts?.month || {};
  const data = {
    model: vehicle.model || null,
    trim: vehicle.trim || null,
    state: vehicle.state || null,
    battery_level: metric(vehicle.battery_level, "actual", { unit: "percent" }),
    rated_range_km: metric(vehicle.rated_range_km, "actual", { unit: "km" }),
    ideal_range_km: metric(vehicle.ideal_range_km, "actual", { unit: "km" }),
    odometer_km: metric(vehicle.odometer_km, "actual", { unit: "km" }),
    inside_temp_c: metric(vehicle.inside_temp_c, "actual", { unit: "C" }),
    outside_temp_c: metric(vehicle.outside_temp_c, "actual", { unit: "C" }),
    is_climate_on: vehicle.is_climate_on === true,
    updated_at: vehicle.updated_at || null,
    month: {
      trip_count: metric(month.trip_count, "actual"),
      distance_km: metric(month.distance_km, "actual", { unit: "km" }),
      duration_min: metric(month.duration_min, "actual", { unit: "min" })
    }
  };
  const summary = `最近一次采集：电量 ${data.battery_level.value ?? "未知"}%，额定续航 ${data.rated_range_km.value ?? "未知"} km，状态 ${data.state || "未知"}，总里程 ${data.odometer_km.value ?? "未知"} km。本月 ${data.month.trip_count.value ?? 0} 段、${data.month.distance_km.value ?? 0} km。这是采集库里的最后状态，不是向车辆发出的指令。`;
  return envelope("vehicle_overview", data, summary, options);
}

export function presentCharging(facts, options) {
  const sessions = (facts?.processes || []).map((process) => ({
    started_at: process.start_at || null,
    ended_at: process.end_at || null,
    start_battery_level: metric(process.start_battery_level, "actual", { unit: "percent" }),
    end_battery_level: metric(process.end_battery_level, "actual", { unit: "percent" }),
    energy_kwh: metric(process.charge_energy_added, "actual", { unit: "kWh" })
  }));
  const added = sessions.reduce((total, session) => total + (session.energy_kwh.value || 0), 0);
  const data = {
    window_days: facts?.window_days || 7,
    session_count: metric(sessions.length, "actual"),
    energy_added_kwh: metric(Number(added.toFixed(3)), sessions.length ? "actual" : "unknown", { unit: "kWh" }),
    sessions,
    month_receipts: presentReceipts(facts?.monthReceipts)
  };
  const summary = `近 ${data.window_days} 天已结束充电 ${sessions.length} 次，合计充入 ${data.energy_added_kwh.value ?? "未知"} kWh。本月已确认账单 ${data.month_receipts.count.value ?? 0} 笔、金额 ${money(data.month_receipts.amount_cny.value)}。不含充电地点。`;
  return envelope("charging_summary", data, summary, options);
}
