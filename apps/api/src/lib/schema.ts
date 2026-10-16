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

export const listWorkItemsSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  teamId: z.string().optional(),
  assigneeId: z.string().optional(),
  status: z
    .enum(["OPEN", "IN_PROGRESS", "PENDING_APPROVAL", "RESOLVED", "CLOSED"])
    .optional(),
  priority: z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]).optional(),
  search: z.string().trim().max(100).optional(),
});

export const transitionSchema = z
  .object({
    version: z.number().int().positive(),
    status: z.enum([
      "OPEN",
      "IN_PROGRESS",
      "PENDING_APPROVAL",
      "RESOLVED",
      "CLOSED",
    ]),
  })
  .strict();

export const assignSchema = z
  .object({
    version: z.number().int().positive(),
    assigneeId: z.string().min(1).nullable(),
  })
  .strict();
