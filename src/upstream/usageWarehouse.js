// Usage warehouse adapter. Talks to a Snowflake-style SQL API
// (POST /api/v2/statements with positional bindings). Only parameterised,
// fixed statements are sent - no user input is ever concatenated into SQL.

const SUMMARY_SQL = `
  SELECT month, protected_tb, api_calls, active_users
  FROM usage_monthly
  WHERE account_id = ?
  ORDER BY month DESC
  LIMIT 4`;

export function createUsageWarehouse(http) {
  return {
    async summary(accountId, correlationId) {
      const res = await http.request('POST', '/api/v2/statements', {
        body: { statement: SUMMARY_SQL, bindings: { 1: { type: 'TEXT', value: accountId } }, timeout: 5 },
        retry: true, // read-only statement
        correlationId,
      });
      const cols = res.body.resultSetMetaData.rowType.map((c) => c.name.toLowerCase());
      const rows = res.body.data.map((r) => Object.fromEntries(cols.map((c, i) => [c, r[i]])));
      if (!rows.length) return null;

      const latest = rows[0];
      const base = rows[3];
      const tb = Number(latest.protected_tb);
      return {
        month: latest.month,
        protectedTb: tb,
        apiCalls: Number(latest.api_calls),
        activeUsers: Number(latest.active_users),
        protectedTbChange3mPct: base ? Math.round(((tb - Number(base.protected_tb)) / Number(base.protected_tb)) * 1000) / 10 : null,
      };
    },
  };
}
