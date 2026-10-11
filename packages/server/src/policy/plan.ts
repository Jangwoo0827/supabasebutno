import type { SqlValue } from '../db/driver.js';
import { AppError } from '../core/errors.js';
import type { Role } from '../http/types.js';
import { UNRESTRICTED, type AccessPlan } from '../rest/engine.js';
import { matches, toSql, type EvalContext } from './eval.js';
import type { Expr, Policy, PolicyRole } from './types.js';

export type RequestKind = 'select' | 'insert' | 'upsert' | 'update' | 'delete';

/** Deliberately vague: it must not reveal whether the table exists or which rule is missing. */
export const forbidden = () => new AppError(403, 'forbidden', 'No access policy allows this request');

/**
 * Decides what a caller may do and turns the table's policy into an AccessPlan.
 *
 *  - service_role bypasses everything.
 *  - Everybody else needs a rule for the operation that lists their role. No policy, no
 *    rule, or the wrong role all end in the same 403 (deny by default).
 *  - `wantRows` (Prefer: return=representation) additionally needs a SELECT rule, and the
 *    returned rows are filtered through it, so a write can never be used to read rows
 *    the caller could not read directly.
 */
export function buildPlan(kind: RequestKind, role: Role, userId: string | null, policy: Policy | undefined, wantRows: boolean): AccessPlan {
  if (role === 'service_role') return UNRESTRICTED;
  const caller = role as PolicyRole;
  const ctx: EvalContext = { uid: userId };
  const allowed = <R extends { roles: PolicyRole[] }>(rule: R | undefined): R => {
    if (!rule || !rule.roles.includes(caller)) throw forbidden();
    return rule;
  };
  const sql = (e: Expr) => (p: Parameters<typeof toSql>[2]) => toSql(e, ctx, p);
  const test = (e: Expr) => (row: Record<string, unknown>) => matches(e, row, ctx);
  const forced = (rule: NonNullable<Policy['insert']>): Record<string, SqlValue> =>
    Object.fromEntries(Object.entries(rule.set).map(([col, o]) => [col, o.kind === 'lit' ? o.value : userId]));

  let plan: AccessPlan;
  switch (kind) {
    case 'select': {
      const r = allowed(policy?.select);
      return { restricted: true, where: [sql(r.where)] };
    }
    case 'insert': {
      const r = allowed(policy?.insert);
      plan = { restricted: true, where: [], check: test(r.check), set: forced(r) };
      break;
    }
    case 'upsert': {
      // Both halves must be permitted, and the stored row must satisfy both rules.
      const ins = allowed(policy?.insert);
      const upd = allowed(policy?.update);
      plan = {
        restricted: true,
        where: [sql(upd.where)],
        check: (row) => matches(ins.check, row, ctx) && matches(upd.check, row, ctx),
        set: forced(ins),
      };
      break;
    }
    case 'update': {
      const r = allowed(policy?.update);
      plan = { restricted: true, where: [sql(r.where)], check: test(r.check) };
      break;
    }
    case 'delete': {
      const r = allowed(policy?.delete);
      plan = { restricted: true, where: [sql(r.where)] };
      break;
    }
  }

  if (wantRows) plan.canRead = test(allowed(policy?.select).where);
  return plan;
}
