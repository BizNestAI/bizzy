# Bid Builder Ops

## Site Photo Attachments

Bid Builder uploads site photos and lightweight files through the backend into Supabase Storage.

- Environment variable: `BID_ATTACHMENTS_BUCKET`
- Default bucket name: `bid-attachments`
- Upload path: `{business_id}/{bid_estimate_id}/{timestamp}-{sanitized_file_name}`
- Stored metadata table: `public.bid_attachments`

Create the bucket in each Supabase project before enabling uploads in staging or production. The current UI stores and renders `file_url`, so the bucket should be public unless the attachment flow is changed to issue signed URLs.

Photo analysis is not implemented yet. Attachments are stored only as bid context.
