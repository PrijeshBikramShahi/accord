import { z } from 'zod';

const text = (max: number) => z.string().trim().min(1).max(max);
export const loginSchema = z.object({ email: z.email().max(200), password: z.string().min(1).max(256) }).strict();
export const projectSchema = z.object({ title: text(120), description: text(1000), clientId: text(100) }).strict();
export const paragraphSchema = z.object({ id: z.string().regex(/^p-[a-zA-Z0-9-]{1,80}$/), text: text(4000) }).strict();
export const briefSchema = z.object({ expectedVersion: z.number().int().min(0), paragraphs: z.array(paragraphSchema).min(1).max(30), incorporatedChangeIds: z.array(text(100)).max(100).default([]) }).strict().refine(value => new Set(value.paragraphs.map(p => p.id)).size === value.paragraphs.length && new Set(value.incorporatedChangeIds).size === value.incorporatedChangeIds.length, 'Paragraph and incorporated change IDs must be unique');
export const versionSchema = z.object({ expectedVersion: z.number().int().positive() }).strict();
export const deliverableSchema = z.object({ title: text(120), description: text(2000), acceptanceCriteria: text(4000) }).strict();
export const deliverableUpdateSchema = deliverableSchema.extend({ expectedVersion: z.number().int().positive() }).strict();
export const commentSchema = z.object({ body: text(4000), deliverableId: text(100).optional(), correctionOf: text(100).optional() }).strict();
export const approvalSchema = z.object({ targetType: z.enum(['brief', 'deliverable', 'change']), targetId: text(100), version: z.number().int().positive(), hash: z.string().regex(/^[a-f0-9]{64}$/), decision: z.enum(['approve', 'reject']), expectedScopeRevision: z.number().int().min(0) }).strict();
export const changeSchema = z.object({ title: text(120), scopeDelta: text(4000), acceptanceCriteria: text(4000), scheduleImplications: text(1000), feeImplications: text(1000), sourceFeedbackId: text(100), rationale: text(2000), expectedScopeRevision: z.number().int().min(0), expectedVersion: z.number().int().min(0) }).strict();
export const authoritySchema = z.object({ type: z.enum(['brief', 'change']), id: text(100), version: z.number().int().positive(), hash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const taskSchema = z.object({ title: text(120), acceptanceCriteria: text(4000), sourceFeedbackId: text(100), rationale: text(2000), authority: authoritySchema, expectedScopeRevision: z.number().int().min(0) }).strict();
export const taskUpdateSchema = z.object({ expectedVersion: z.number().int().positive(), status: z.enum(['todo', 'in_progress', 'complete']), expectedScopeRevision: z.number().int().min(0) }).strict();
export const attachmentParentSchema = z.discriminatedUnion('type', [z.object({ type: z.literal('project') }).strict(), z.object({ type: z.literal('deliverable'), id: text(100), version: z.number().int().positive() }).strict()]);
export const attachmentSchema = z.object({ filename: z.string().min(1).max(180).regex(/^[^/\\\x00-\x1f\x7f]+$/), mime: z.enum(['application/pdf', 'image/png', 'image/jpeg', 'text/plain']), size: z.number().int().min(1).max(5 * 1024 * 1024), checksum: z.string().regex(/^[a-f0-9]{64}$/), parent: attachmentParentSchema }).strict();
export const attachmentCompleteSchema = z.object({ expectedVersion: z.literal(1), dataBase64: z.string().min(4).max(6990508).regex(/^[A-Za-z0-9+/]*={0,2}$/).refine(value => value.length % 4 === 0, 'Invalid base64 length') }).strict();

export type Identity = { id: string; workspaceId: string; name: string; email: string; role: 'owner' | 'client' };
export type Project = { id: string; workspaceId: string; title: string; description: string; ownerId: string; clientId: string; scopeRevision: number; contextRevision: number; createdAt: string };
export type Paragraph = z.infer<typeof paragraphSchema>;
export type VersionStatus = 'draft' | 'submitted' | 'approved' | 'rejected';
export type Brief = { version: number; paragraphs: Paragraph[]; incorporatedChangeIds: string[]; hash: string; status: VersionStatus; createdAt: string; createdBy: string };
export type Deliverable = z.infer<typeof deliverableSchema> & { id: string; version: number; hash: string; status: VersionStatus; createdAt: string; createdBy: string };
export type Comment = z.infer<typeof commentSchema> & { id: string; authorId: string; authorName: string; createdAt: string };
export type Approval = z.infer<typeof approvalSchema> & { id: string; actorId: string; createdAt: string };
export type ChangeRequest = Omit<z.infer<typeof changeSchema>, 'expectedVersion' | 'expectedScopeRevision'> & { id: string; version: number; baseScopeRevision: number; hash: string; status: VersionStatus; createdAt: string; createdBy: string };
export type RevisionTask = Omit<z.infer<typeof taskSchema>, 'expectedScopeRevision'> & { id: string; version: number; status: 'todo' | 'in_progress' | 'complete'; scopeRevision: number; approvalId: string; decisionId: string; createdAt: string; createdBy: string };
export type Attachment = z.infer<typeof attachmentSchema> & { id: string; version: 1; objectKey: string; status: 'pending' | 'ready'; uploaderId: string; createdAt: string; expiresAt: number };
export type EffectiveScope = { brief: Brief | null; changes: ChangeRequest[]; scopeRevision: number };
export type Audit = { id: string; actorId: string; actorName: string; action: string; targetId: string; version?: number; createdAt: string };
export type WorkspaceView = { project: Project; briefs: Brief[]; deliverables: Deliverable[]; comments: Comment[]; approvals: Approval[]; history: Audit[]; changes: ChangeRequest[]; tasks: RevisionTask[]; attachments: Attachment[]; scope: EffectiveScope };
export type Page<T> = { items: T[]; nextCursor: string | null };

export const analysisRequestSchema = z.object({ feedbackId: text(100) }).strict();
export const citationSchema = z.object({ sourceId: text(180), version: z.number().int().positive(), paragraphId: text(100), quote: text(4000) }).strict();
export const findingSchema = z.object({ id: text(100), feedbackId: text(100), requestSpan: text(4000), label: z.enum(['likely_included', 'possible_scope_addition', 'unclear']), rationale: text(1200), citations: z.array(citationSchema).min(1).max(8), missingInformation: z.array(text(500)).max(8), proposedAction: text(1000) }).strict();
export const analysisResultSchema = z.object({ findings: z.array(findingSchema).min(1).max(10) }).strict();
const reviewBase = { findingId: text(100), rationale: text(2000) };
export const reviewSchema = z.discriminatedUnion('action', [
  z.object({ ...reviewBase, action: z.literal('reject') }).strict(),
  z.object({ ...reviewBase, action: z.literal('task'), title: text(120), acceptanceCriteria: text(4000), authority: authoritySchema }).strict(),
  z.object({ ...reviewBase, action: z.literal('change'), title: text(120), scopeDelta: text(4000), acceptanceCriteria: text(4000), scheduleImplications: text(1000), feeImplications: text(1000) }).strict(),
  z.object({ ...reviewBase, action: z.literal('clarification'), body: text(4000) }).strict(),
]);
export type AnalysisSource = { id: string; resourceId: string; authorName?: string; createdAt?: string; correctionOf?: string; type: 'brief' | 'change' | 'feedback' | 'deliverable'; version: number; status: string; hash: string; paragraphs: Paragraph[] };
export type AnalysisFinding = z.infer<typeof findingSchema>;
export type AnalysisResult = z.infer<typeof analysisResultSchema>;
export type ReviewDecision = z.infer<typeof reviewSchema> & { id: string; jobId: string; actorId: string; createdAt: string; targetId?: string; publishedCommentId?: string };
export type AnalysisJob = { id: string; version: number; requesterId: string; feedbackId: string; scopeRevision: number; contextRevision: number; sources: AnalysisSource[]; manifestHash: string; provider: 'fixture'; modelVersion: 'atlas-demo-v1'; promptVersion: 'scope-review-v1'; status: 'pending_dispatch' | 'queued' | 'running' | 'succeeded' | 'failed' | 'stale'; attempts: number; createdAt: string; updatedAt: string; leaseToken?: string; leaseUntil?: number; error?: string; retryable?: boolean; retryAfter?: number; result?: AnalysisResult; durationMs?: number; inputBytes: number; costMicros: 0 };
export type AnalysisView = Omit<AnalysisJob, 'leaseToken'> & { stale: boolean; recoverable: boolean; decisions: ReviewDecision[] };
