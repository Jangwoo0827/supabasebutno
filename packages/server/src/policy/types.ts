import type { SqlValue } from '../db/driver.js';

/** Roles a policy can grant. `service_role` bypasses policies entirely and is never listed. */
export const POLICY_ROLES = ['anon', 'authenticated'] as const;
export type PolicyRole = (typeof POLICY_ROLES)[number];

export const COMPARISON_OPS = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte'] as const;
export type ComparisonOp = (typeof COMPARISON_OPS)[number];

/**
 * A value inside a condition: either a literal already converted to its database
 * representation (booleans are 0/1, timestamps normalised), or a request variable.
 * `uid` is the signed-in user's id, or NULL for anon (and NULL never equals anything).
 */
export type Operand = { kind: 'lit'; value: SqlValue } | { kind: 'var'; name: 'uid' };

/** Condition tree (the compiled form of the JSON a policy author writes). */
export type Expr =
  | { kind: 'true' }
  | { kind: 'cmp'; column: string; op: ComparisonOp; operand: Operand }
  | { kind: 'in'; column: string; operands: Operand[] }
  | { kind: 'isnull'; column: string }
  | { kind: 'and'; items: Expr[] }
  | { kind: 'or'; items: Expr[] }
  | { kind: 'not'; item: Expr };

export interface SelectRule {
  roles: PolicyRole[];
  where: Expr;
}
export interface InsertRule {
  roles: PolicyRole[];
  /** The stored row must satisfy this, or the whole request is rolled back. */
  check: Expr;
  /** Columns forced to a value on insert, overriding whatever the client sent. */
  set: Record<string, Operand>;
}
export interface UpdateRule {
  roles: PolicyRole[];
  /** Which existing rows may be touched. */
  where: Expr;
  /** The row AFTER the update must satisfy this (defaults to `where`). */
  check: Expr;
}
export interface DeleteRule {
  roles: PolicyRole[];
  where: Expr;
}

/** Compiled policy of one table. An operation without a rule is denied. */
export interface Policy {
  select?: SelectRule;
  insert?: InsertRule;
  update?: UpdateRule;
  delete?: DeleteRule;
}

export const TRUE_EXPR: Expr = { kind: 'true' };
