import type { TableInfo } from '../schema/types.js';

export type ChangeType = 'INSERT' | 'UPDATE' | 'DELETE';

/**
 * One committed row change. Rows are in database form (booleans 0/1, JSON as text), exactly
 * as returned by RETURNING, so the policy and filter evaluators can work on them directly.
 */
export interface RowChange {
  type: ChangeType;
  table: TableInfo;
  /** INSERT, UPDATE */
  new?: Record<string, unknown>;
  /** UPDATE, DELETE (UPDATE: only if the previous row could be identified) */
  old?: Record<string, unknown>;
}
