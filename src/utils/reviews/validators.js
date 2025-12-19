import { z } from 'zod';

export const listReviewsQuery = z.object({
  business_id: z.string().uuid(),
  source: z.enum(['google','facebook','yelp']).optional(),
  rating_min: z.coerce.number().min(1).max(5).optional(),
  rating_max: z.coerce.number().min(1).max(5).optional(),
  sentiment: z.enum(['positive','neutral','negative']).optional(),
  replied: z.coerce.boolean().optional(),
  since: z.string().datetime().optional(),
  until: z.string().datetime().optional(),
  q: z.string().max(200).optional(),
  limit: z.coerce.number().min(1).max(200).optional().default(50),
  offset: z.coerce.number().min(0).optional().default(0),
});

export const statsQuery = z.object({
  business_id: z.string().uuid(),
  range: z.enum(['30d','90d','365d']).optional().default('30d'),
});

export const replyBody = z.object({
  channel: z.enum(['email','sms']).optional().default('email'),
  draft_text: z.string().min(1).max(1200),
});

export const requestBody = z.object({
  business_id: z.string().uuid(),
  job_id: z.string().uuid().nullable().optional(),
  customer_email: z.string().email(),
  channel: z.enum(['email','sms']).default('email'),
  scheduled_at: z.string().datetime().optional(),
});

export const csvImportBody = z.object({
  business_id: z.string().uuid(),
  csv_base64: z.string(),
});

export const connectGoogleBody = z.object({
  business_id: z.string().uuid(),
});
