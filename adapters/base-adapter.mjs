export class BaseAdapter {
  static agentObject = "abstract";
  static adapterVersion = "0.2.0";

  constructor(config) {
    this.config = config;
  }

  async discover(config) {
    throw new Error("discover() not implemented");
  }

  async capabilities(context) {
    throw new Error("capabilities() not implemented");
  }

  async extractSessions(options = {}) {
    throw new Error("extractSessions() not implemented");
  }

  async extractTurns(sessionId, options = {}) {
    throw new Error("extractTurns() not implemented");
  }

  async extractEvents(sessionId, options = {}) {
    throw new Error("extractEvents() not implemented");
  }

  async extractCalls(sessionId, options = {}) {
    throw new Error("extractCalls() not implemented");
  }

  async extractUsage(sessionId, options = {}) {
    throw new Error("extractUsage() not implemented");
  }

  async extractFailures(sessionId, options = {}) {
    throw new Error("extractFailures() not implemented");
  }

  async extractMetrics(sessionId, options = {}) {
    throw new Error("extractMetrics() must delegate to shared metrics engine");
  }

  async extractTimeline(sessionId, options = {}) {
    return [];
  }

  async subscribe(options = {}) {
    return null;
  }

  async close() {}
}
