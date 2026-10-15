import { randomUUID } from 'node:crypto';
import type { Approval, Attachment, Audit, Brief, ChangeRequest, Comment, Deliverable, Identity, Project } from '../../../packages/shared/src/index.ts';
import { approvalSchema, briefSchema, commentSchema, deliverableSchema, deliverableUpdateSchema, projectSchema, versionSchema } from '../../../packages/shared/src/index.ts';
import { hash, Store } from './store.ts';

export class Problem extends Error { constructor(readonly status: number, message: string) { super(message); } }
const now = () => new Date().toISOString();
export function authorize(store: Store, user: Identity, projectId: string, ownerOnly = false): Project {
  const project = store.project(projectId);
  if (!project || project.workspaceId !== user.workspaceId || ![project.ownerId, project.clientId].includes(user.id)) throw new Problem(404, 'Project not found.');
  if (ownerOnly && (user.role !== 'owner' || project.ownerId !== user.id)) throw new Problem(404, 'Resource not found.');
  return project;
}
function owner(user: Identity) { if (user.role !== 'owner') throw new Problem(404, 'Resource not found.'); }
function expected(actual: number, requested: number) { if (actual !== requested) throw new Problem(409, 'This version has changed. Refresh and review the latest version.'); }
export function audit(store: Store, projectId: string, user: Identity, action: string, targetId: string, version?: number) {
  const event: Audit = { id: randomUUID(), actorId: user.id, actorName: user.name, action, targetId, version, createdAt: now() };
  store.put(projectId, 'history', event.id, 1, event);
}
function advance(store: Store, project: Project, scope = false) { project.contextRevision++; if (scope) project.scopeRevision++; store.saveProject(project); }
export function createProject(store: Store, user: Identity, input: unknown) {
  owner(user);
  const data = projectSchema.parse(input);
  const client = store.user(data.clientId);
  if (!client || client.role !== 'client' || client.workspaceId !== user.workspaceId) throw new Problem(422, 'Choose an existing client in your workspace.');
  const project: Project = { ...data, id: randomUUID(), workspaceId: user.workspaceId, ownerId: user.id, scopeRevision: 0, contextRevision: 0, createdAt: now() };
  store.saveProject(project);
  audit(store, project.id, user, 'Project created', project.id);
  return project;
}
export function createBrief(store: Store, user: Identity, projectId: string, input: unknown) {
  authorize(store, user, projectId, true);
  const data = briefSchema.parse(input);
  const latest = store.list<Brief>(projectId, 'briefs')[0];
  expected(latest?.version ?? 0, data.expectedVersion);
  validateIncorporation(store, projectId, data.incorporatedChangeIds);
  const content = { paragraphs: data.paragraphs, incorporatedChangeIds: data.incorporatedChangeIds };
  const brief: Brief = { ...content, version: data.expectedVersion + 1, hash: hash(content), status: 'draft', createdAt: now(), createdBy: user.id };
  store.put(projectId, 'briefs', 'brief', brief.version, brief);
  audit(store, projectId, user, 'Brief draft saved', 'brief', brief.version);
  return brief;
}
export function createDeliverable(store: Store, user: Identity, projectId: string, input: unknown, id?: string) {
  authorize(store, user, projectId, true);
  const data = id ? deliverableUpdateSchema.parse(input) : deliverableSchema.parse(input);
  const latest = id ? store.list<Deliverable>(projectId, 'deliverables').find(d => d.id === id) : undefined;
  if (id && !latest) throw new Problem(404, 'Deliverable not found.');
  if (latest) expected(latest.version, deliverableUpdateSchema.parse(input).expectedVersion);
  const content = { title: data.title, description: data.description, acceptanceCriteria: data.acceptanceCriteria };
  const deliverable: Deliverable = { ...content, id: id ?? randomUUID(), version: (latest?.version ?? 0) + 1, hash: hash(content), status: 'draft', createdAt: now(), createdBy: user.id };
  store.put(projectId, 'deliverables', deliverable.id, deliverable.version, deliverable);
  audit(store, projectId, user, 'Deliverable draft saved', deliverable.id, deliverable.version);
  return deliverable;
}
export function submit(store: Store, user: Identity, projectId: string, kind: 'briefs' | 'deliverables' | 'changes', id: string, version: number, input: unknown) {
  const project = authorize(store, user, projectId, true);
  const data = versionSchema.parse(input);
  const all = store.list<Brief | Deliverable | ChangeRequest>(projectId, kind).filter(v => kind === 'briefs' || ('id' in v && v.id === id));
  const target = all.find(v => v.version === version);
  if (!target) throw new Problem(404, 'Version not found.');
  expected(all[0].version, data.expectedVersion);
  expected(target.version, data.expectedVersion);
  if (target.status !== 'draft') throw new Problem(409, 'Only the latest draft can be submitted.');
  if ('baseScopeRevision' in target) expected(project.scopeRevision, target.baseScopeRevision);
  if ('incorporatedChangeIds' in target) validateIncorporation(store, projectId, target.incorporatedChangeIds);
  if (kind === 'deliverables' && store.list<Attachment>(projectId, 'attachments').some(a => a.parent.type === 'deliverable' && a.parent.id === id && a.parent.version === version && a.status === 'pending' && a.expiresAt > Date.now())) throw new Problem(409, 'Finish pending uploads before submitting this deliverable.');
  target.status = 'submitted';
  store.put(projectId, kind, id, version, target);
  advance(store, project);
  audit(store, projectId, user, `${kind === 'briefs' ? 'Brief' : kind === 'changes' ? 'Change request' : 'Deliverable'} submitted`, id, version);
  return target;
}
export function approve(store: Store, user: Identity, projectId: string, input: unknown) {
  const project = authorize(store, user, projectId);
  if (user.role !== 'client' || project.clientId !== user.id) throw new Problem(404, 'Resource not found.');
  const data = approvalSchema.parse(input);
  const kind = data.targetType === 'brief' ? 'briefs' : data.targetType === 'change' ? 'changes' : 'deliverables';
  if (kind === 'briefs' && data.targetId !== 'brief') throw new Problem(404, 'Brief not found.');
  const versions = store.list<Brief | Deliverable | ChangeRequest>(projectId, kind).filter(v => kind === 'briefs' || ('id' in v && v.id === data.targetId));
  const target = versions.find(v => v.version === data.version);
  if (!target || target.status === 'draft') throw new Problem(404, 'Submitted version not found.');
  expected(project.scopeRevision, data.expectedScopeRevision);
  expected(versions[0].version, data.version);
  if (target.status !== 'submitted' || target.hash !== data.hash) throw new Problem(409, 'Only the exact, current submitted version can be reviewed.');
  if (data.decision === 'approve' && 'baseScopeRevision' in target) expected(project.scopeRevision, target.baseScopeRevision);
  if ('incorporatedChangeIds' in target) validateIncorporation(store, projectId, target.incorporatedChangeIds);
  const approval: Approval = { ...data, id: randomUUID(), actorId: user.id, createdAt: now() };
  target.status = data.decision === 'approve' ? 'approved' : 'rejected';
  store.put(projectId, kind, data.targetId, target.version, target);
  store.put(projectId, 'approvals', approval.id, 1, approval);
  advance(store, project, data.targetType !== 'deliverable' && data.decision === 'approve');
  audit(store, projectId, user, `${data.targetType === 'brief' ? 'Brief' : data.targetType === 'change' ? 'Change request' : 'Deliverable'} ${target.status}`, data.targetId, target.version);
  return approval;
}
export function addComment(store: Store, user: Identity, projectId: string, input: unknown) {
  const project = authorize(store, user, projectId);
  const data = commentSchema.parse(input);
  if (data.deliverableId && !store.list<Deliverable>(projectId, 'deliverables').some(d => d.id === data.deliverableId && d.status !== 'draft')) throw new Problem(404, 'Shared deliverable not found.');
  if (data.correctionOf) {
    const original = store.get<Comment>(projectId, 'comments', data.correctionOf, 1);
    if (!original || original.authorId !== user.id || original.deliverableId !== data.deliverableId) throw new Problem(422, 'A correction must reference your own comment in the same thread.');
  }
  const comment: Comment = { ...data, id: randomUUID(), authorId: user.id, authorName: user.name, createdAt: now() };
  store.put(projectId, 'comments', comment.id, 1, comment);
  advance(store, project);
  audit(store, projectId, user, data.correctionOf ? 'Feedback corrected' : 'Feedback posted', comment.id);
  return comment;
}

function validateIncorporation(store: Store, projectId: string, ids: string[]) {
  for (const id of ids) if (!store.list<ChangeRequest>(projectId, 'changes').some(c => c.id === id && c.status === 'approved')) throw new Problem(422, 'Only approved changes from this project can be incorporated.');
  // Once incorporated, a change must stay explicitly represented in replacement briefs.
  const baseline = store.list<Brief>(projectId, 'briefs').find(b => b.status === 'approved');
  if (baseline?.incorporatedChangeIds.some(id => !ids.includes(id))) throw new Problem(422, 'Keep previously incorporated changes listed in the replacement brief.');
}
