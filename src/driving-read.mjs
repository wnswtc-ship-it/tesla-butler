import { calculateFuelComparisons } from "./comparisons.mjs";
import { getElectricityCostSummary } from "./electricity-cost-service.mjs";
import { selectMainRoute } from "./routes.mjs";
import { getReceiptTotals } from "./store.mjs";
import {
  getCollectionStatus,
  getLatestTripGroup,
  getPeriodRouteCandidates,
  getPeriodTrips,
  getRecentChargingProcesses,
  getTripInsightHistory,
  getVehicleOverview
} from "./teslamate.mjs";
import { selectTripAdviceForTrip } from "./trip-insights.mjs";

export const drivingPeriods = Object.freeze(["week", "month", "previous_week", "previous_month"]);

function adviceLine(event) {
  return `trip_advice code=${event.code || "hidden"} baseline_count=${event.baseline_count || 0}`;
}

export function createDrivingReader(overrides = {}) {
  const deps = {
    getLatestTripGroup,
    getPeriodTrips,
    getPeriodRouteCandidates,
    getVehicleOverview,
    getCollectionStatus,
    getRecentChargingProcesses,
    getReceiptTotals,
    getElectricityCostSummary,
    calculateFuelComparisons,
    selectMainRoute,
    getTripInsightHistory,
    selectTripAdviceForTrip,
    now: () => new Date(),
    log: (message) => process.stderr.write(`[${new Date().toISOString()}] ${message}\n`),
    ...overrides
  };

  return {
    async decorateTrip(trip) {
      if (!trip?.segment_ids?.length) return { trip: trip || null, pricingSummary: null, advice: null };
      const [pricingSummary, advice] = await Promise.all([
        deps.getElectricityCostSummary(trip.segment_ids),
        (async () => {
          try {
            const selected = deps.selectTripAdviceForTrip(trip, await deps.getTripInsightHistory());
            deps.log(adviceLine({ code: selected?.code || "hidden", baseline_count: selected?.baseline_count || 0 }));
            return selected;
          } catch {
            deps.log(adviceLine({ code: "metrics_unavailable", baseline_count: 0 }));
            return null;
          }
        })()
      ]);
      return { trip, pricingSummary, advice };
    },

    async latestTrip() {
      return this.decorateTrip(await deps.getLatestTripGroup());
    },

    async periodReport(period) {
      if (!drivingPeriods.includes(period)) {
        throw Object.assign(new Error("unsupported period"), { code: "INVALID_ARGUMENT" });
      }
      const monthly = period === "month" || period === "previous_month";
      const [trips, receipts, routeCandidates] = await Promise.all([
        deps.getPeriodTrips(period),
        deps.getReceiptTotals(period),
        monthly ? deps.getPeriodRouteCandidates(period) : Promise.resolve(null)
      ]);
      const pricingSummary = await deps.getElectricityCostSummary(trips?.drive_ids || []);
      const tripElectricCost = pricingSummary?.cost_cny ?? null;
      return {
        period,
        trips,
        receipts,
        pricingSummary,
        tripElectricCost,
        comparisons: deps.calculateFuelComparisons(trips?.distance_km, tripElectricCost),
        mainRoute: monthly ? deps.selectMainRoute(routeCandidates) : undefined
      };
    },

    async vehicleOverview() {
      const [vehicle, month] = await Promise.all([
        deps.getVehicleOverview(),
        deps.getPeriodTrips("month")
      ]);
      return { vehicle, month };
    },

    collectionStatus() {
      return deps.getCollectionStatus();
    },

    async recentCharging() {
      const before = deps.now();
      const [processes, monthReceipts] = await Promise.all([
        deps.getRecentChargingProcesses({ before, days: 7, limit: 10 }),
        deps.getReceiptTotals("month")
      ]);
      return {
        processes: Array.isArray(processes) ? processes : [],
        monthReceipts,
        window_days: 7
      };
    }
  };
}
