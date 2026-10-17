import { z } from "zod";

export const createWorkItemSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().min(1).max(10_000),
    category: z.enum([
      "CUSTOMER_ISSUE",
      "ENGINEERING",
      "PAYMENT",
      "INCIDENT",
      "COMPLIANCE",
      "OPERATIONS",
      "OTHER",
    ]),
    priority: z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]).default("MEDIUM"),
    teamId: z.string().min(1),
    assigneeId: z.string().min(1).optional(),
    dueAt: z.coerce.date().optional(),
  })
  .strict();

export const updateWorkItemSchema = z
  .object({
    version: z.number().int().positive(),
    title: z.string().trim().min(3).max(200).optional(),
    description: z.string().trim().min(1).max(10_000).optional(),
    priority: z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]).optional(),
    dueAt: z.coerce.date().nullable().optional(),
  })
  .strict()
  .refine(({ version, ...fields }) => Object.keys(fields).length > 0, {
    message: "Provide at least one field to update",
  });

export const listWorkItemsSchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    teamId: z.string().optional(),
    team_id: z.string().optional(),
    assigneeId: z.string().optional(),
    assignee_id: z.string().optional(),
    status: z
      .enum(["OPEN", "IN_PROGRESS", "PENDING_APPROVAL", "RESOLVED", "CLOSED"])
      .optional(),
    priority: z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]).optional(),
    search: z.string().trim().max(100).optional(),
    q: z.string().trim().max(100).optional(),
  })
  .transform((data) => ({
    page: data.page,
    limit: data.limit,
    teamId: data.teamId ?? data.team_id,
    assigneeId: data.assigneeId ?? data.assignee_id,
    status: data.status,
    priority: data.priority,
    search: data.search ?? data.q,
  }));

export const transitionSchema = z
  .object({
    version: z.number().int().positive().optional(),
    status: z
      .enum(["OPEN", "IN_PROGRESS", "PENDING_APPROVAL", "RESOLVED", "CLOSED"])
      .optional(),
    target_status: z
      .enum(["OPEN", "IN_PROGRESS", "PENDING_APPROVAL", "RESOLVED", "CLOSED"])
      .optional(),
  })
  .refine((data) => data.status !== undefined || data.target_status !== undefined, {
    message: "status or target_status is required",
  })
  .transform((data) => ({
    version: data.version,
    status: (data.status ?? data.target_status)!,
  }));

export const assignSchema = z
  .object({
    version: z.number().int().positive().optional(),
    assigneeId: z.string().min(1).nullable().optional(),
    assignee_id: z.string().min(1).nullable().optional(),
  })
  .transform((data) => ({
    version: data.version,
    assigneeId: data.assigneeId !== undefined ? data.assigneeId : (data.assignee_id ?? null),
  }));

export const approveRejectSchema = z.object({
  version: z.number().int().positive().optional(),
  reason: z.string().trim().max(1000).optional(),
});

export const commentSchema = z
  .object({
    body: z.string().trim().min(1).max(10_000).optional(),
    message: z.string().trim().min(1).max(10_000).optional(),
    is_internal: z.boolean().default(false),
    isInternal: z.boolean().optional(),
  })
  .refine((data) => data.body !== undefined || data.message !== undefined, {
    message: "Comment body is required",
  })
  .transform((data) => ({
    body: (data.body ?? data.message)!,
    isInternal: data.isInternal ?? data.is_internal,
  }));

export const timelineQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  before_id: z.string().optional(),
});
