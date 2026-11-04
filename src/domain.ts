import type { User } from './auth.js';
// Superiors see their reports' tasks; reports never see their superiors' tasks.
// Once the org has reporting lines, a user sees tasks they own, review, or that belong to anyone below them.
// Before any reporting line exists, the original department rule applies so nothing disappears during rollout.
export function visibleTask(user: User, task: any) {
  // A deleted (archived) task is gone for everyone until it is restored.
  if (!task || task.org_id !== user.org_id || task.archived_at) return false;
  if (task.owner_id === user.id || task.reviewer_id === user.id) return true;
  if (Array.isArray(user.visibleOwnerIds)) return user.visibleOwnerIds.includes(task.owner_id);
  return user.role === 'manager' && task.department_id === user.department_id;
}
/** A reviewer must differ from the owner and be either a manager in the same department
 * or the owner's own manager (so a department with a single manager still works). */
export function reviewerAllowed(owner: any, reviewer: any, orgId: string, departmentId: string) {
  if (!owner || !reviewer || reviewer.id === owner.id || reviewer.org_id !== orgId || reviewer.active === false) return false;
  return (reviewer.role === 'manager' && reviewer.department_id === departmentId) || (!!owner.manager_id && reviewer.id === owner.manager_id) || (!!owner.second_manager_id && reviewer.id === owner.second_manager_id);
}
/** Reporting edges along both lines: a first leader (manager_id) and a second leader (second_manager_id)
 * have the same rights over the person and, as for any leader, over that person's own team. */
export function leaderChildren(rows: { id: string; manager_id: string | null; second_manager_id?: string | null }[]) {
  const children = new Map<string, string[]>();
  const add = (m: string | null | undefined, c: string) => { if (!m || m === c) return; if (!children.has(m)) children.set(m, []); children.get(m)!.push(c); };
  for (const r of rows) { add(r.manager_id, r.id); add(r.second_manager_id, r.id); }
  return children;
}
export async function attachReportingScope(db: { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> }, user: User) {
  const rows = (await db.query('SELECT id,manager_id,second_manager_id FROM users WHERE org_id=$1 AND active=true', [user.org_id])).rows as { id: string; manager_id: string | null; second_manager_id: string | null }[];
  user.dottedOwnerIds = rows.filter(r => r.second_manager_id === user.id && r.id !== user.id).map(r => r.id);
  if (!rows.some(r => r.manager_id || r.second_manager_id)) { user.visibleOwnerIds = null; return user; }
  const children = leaderChildren(rows);
  const seen = new Set<string>([user.id]), queue = [...(children.get(user.id) || [])];
  while (queue.length) { const cur = queue.shift()!; if (seen.has(cur)) continue; seen.add(cur); queue.push(...(children.get(cur) || [])); }
  user.visibleOwnerIds = [...seen];
  return user;
}
export function visibleObjective(user: User, objective: any) {
  return objective && objective.org_id === user.org_id && (objective.level === 'company' || (objective.department_id === user.department_id && (objective.level === 'department' || user.role === 'manager' || objective.owner_id === user.id)));
}
type KrMetric = { baseline?: number | null; target?: number | null; actual?: number | null; direction?: string | null; unit?: string | null };
export function hasKrMetric(kr: KrMetric): kr is KrMetric & { baseline: number; target: number; direction: 'increase' | 'decrease' } {
  if (typeof kr.baseline !== 'number' || !Number.isFinite(kr.baseline) ||
      typeof kr.target !== 'number' || !Number.isFinite(kr.target) ||
      (kr.direction !== 'increase' && kr.direction !== 'decrease')) return false;
  const distance = kr.direction === 'decrease' ? kr.baseline - kr.target : kr.target - kr.baseline;
  return Number.isFinite(distance) && distance > 0;
}
export function krProgress(kr: KrMetric) {
  if (!hasKrMetric(kr) || typeof kr.actual !== 'number' || !Number.isFinite(kr.actual)) return null;
  const distance = kr.direction === 'decrease' ? kr.baseline - kr.target : kr.target - kr.baseline;
  const achieved = kr.direction === 'decrease' ? kr.baseline - kr.actual : kr.actual - kr.baseline;
  return Math.max(0,Math.min(1,achieved / distance));
}
