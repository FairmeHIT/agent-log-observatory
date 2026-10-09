const TZ = process.env.AGENT_LOG_TIMEZONE || "Asia/Shanghai";

export function beijingIso(value = Date.now()) {
  const instant = new Date(value);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant).reduce((acc, p) => ((acc[p.type] = p.value), acc), {});
  const ms = String(instant.getMilliseconds()).padStart(3, "0");
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}.${ms}+08:00`;
}

export function epochToBeijingIso(epochMs) {
  if (epochMs == null || Number.isNaN(epochMs)) return null;
  return beijingIso(epochMs);
}

export function parseEpochMs(value) {
  if (value == null) return null;
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const n = Number(value);
    if (!Number.isNaN(n)) return n;
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d.getTime();
  }
  return null;
}

export function durationHuman(ms) {
  if (ms == null || Number.isNaN(ms)) return null;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3600000) return `${(ms / 60000).toFixed(2)}min`;
  return `${(ms / 3600000).toFixed(2)}h`;
}
