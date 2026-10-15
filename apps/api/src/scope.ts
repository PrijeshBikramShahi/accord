import { randomUUID } from 'node:crypto';
import { changeSchema, taskSchema, taskUpdateSchema, type Approval, type Brief, type ChangeRequest, type Comment, type EffectiveScope, type Identity, type RevisionTask } from '../../../packages/shared/src/index.ts';
import { audit, authorize, Problem } from './domain.ts';
import { hash, Store } from './store.ts';

export function effectiveScope(store: Store, user: Identity, projectId: string): EffectiveScope {
  const project = authorize(store, user, projectId);
  const brief = store.list<Brief>(projectId, 'briefs').find(b => b.status === 'approved') ?? null;
  const changes = store.list<ChangeRequest>(projectId, 'changes').filter(c => c.status === 'approved' && !brief?.incorporatedChangeIds.includes(c.id)).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  return { brief, changes, scopeRevision: project.scopeRevision };
}
function feedback(store: Store, projectId: string, id: string) {
  if (!store.get<Comment>(projectId, 'comments', id, 1)) throw new Problem(404, 'Source feedback not found in this project.');
}
export function createChange(store: Store, user: Identity, projectId: string, input: unknown, id?: string) {
  const project = authorize(store, user, projectId, true);
  const data = changeSchema.parse(input);
  if (data.expectedScopeRevision !== project.scopeRevision) throw new Problem(409, 'Scope changed. Refresh before drafting a change.');
  if (!effectiveScope(store, user, projectId).brief) throw new Problem(409, 'Approve a brief before proposing changes.');
  feedback(store, projectId, data.sourceFeedbackId);
  const versions = id ? store.list<ChangeRequest>(projectId, 'changes').filter(c => c.id === id) : [];
  if (id && !versions.length) throw new Problem(404, 'Change request not found.');
  if (versions.some(c => c.status === 'approved')) throw new Problem(409, 'An approved change is immutable. Propose a separate amendment.');
  if ((versions[0]?.version ?? 0) !== data.expectedVersion) throw new Problem(409, 'Change request version changed. Refresh before editing.');
  const { expectedVersion, expectedScopeRevision, ...content } = data;
  const change: ChangeRequest = { ...content, id: id ?? randomUUID(), version: expectedVersion + 1, baseScopeRevision: expectedScopeRevision, hash: hash({ ...content, baseScopeRevision: expectedScopeRevision }), status: 'draft', createdAt: new Date().toISOString(), createdBy: user.id };
  store.put(projectId, 'changes', change.id, change.version, change);
  audit(store, projectId, user, 'Change request draft saved', change.id, change.version);
  return change;
}
export function createTask(store: Store, user: Identity, projectId: string, input: unknown) {
  const project = authorize(store, user, projectId, true);
  const data = taskSchema.parse(input);
  if (project.scopeRevision !== data.expectedScopeRevision) throw new Problem(409, 'Scope changed. Review it before creating work.');
  feedback(store, projectId, data.sourceFeedbackId);
  const scope = effectiveScope(store, user, projectId);
  const source = data.authority.type === 'brief' && data.authority.id === 'brief' ? scope.brief : data.authority.type === 'change' ? scope.changes.find(c => c.id === data.authority.id) : undefined;
  if (!source || source.version !== data.authority.version || source.hash !== data.authority.hash) throw new Problem(422, 'Tasks require the current approved brief or an active approved change.');
  const approval = store.list<Approval>(projectId, 'approvals').find(a => a.targetType === data.authority.type && a.targetId === data.authority.id && a.version === data.authority.version && a.hash === data.authority.hash && a.decision === 'approve');
  if (!approval) throw new Problem(422, 'The scope approval could not be resolved.');
  const { expectedScopeRevision, ...content } = data;
  const task: RevisionTask = { ...content, id: randomUUID(), version: 1, status: 'todo', scopeRevision: expectedScopeRevision, approvalId: approval.id, decisionId: randomUUID(), createdAt: new Date().toISOString(), createdBy: user.id };
  store.put(projectId, 'tasks', task.id, 1, task);
  store.put(projectId, 'decisions', task.decisionId, 1, { id: task.decisionId, actorId: user.id, rationale: task.rationale, sourceFeedbackId: task.sourceFeedbackId, approvalId: task.approvalId, targetId: task.id, createdAt: task.createdAt, action: 'manual_revision_task' });
  audit(store, projectId, user, 'Revision task created by human decision', task.id, task.version);
  return task;
}
export function updateTask(store: Store, user: Identity, projectId: string, id: string, input: unknown) {
  const project = authorize(store, user, projectId, true);
  const data = taskUpdateSchema.parse(input);
  const task = store.list<RevisionTask>(projectId, 'tasks').find(t => t.id === id);
  if (!task) throw new Problem(404, 'Task not found.');
  if (task.version !== data.expectedVersion || project.scopeRevision !== data.expectedScopeRevision) throw new Problem(409, 'Task or scope changed. Refresh and review before updating.');
  // Preserve the original exact approval/decision even after a replacement brief.
  const updated: RevisionTask = { ...task, version: task.version + 1, status: data.status };
  store.put(projectId, 'tasks', id, updated.version, updated);
  audit(store, projectId, user, `Revision task ${data.status.replace('_', ' ')}`, id, updated.version);
  return updated;
}
