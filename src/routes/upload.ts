import { Hono } from 'hono'
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { Bindings } from '../types'
import { auth } from '../lib/auth'

const app = new Hono<{ Bindings: Bindings }>()

app.post('/url', async (c) => {
  // 1. AUTH CHECK: Who is this user?
  const session = await auth.api.getSession({ headers: c.req.raw.headers })
  if (!session) return c.json({ error: 'Unauthorized' }, 401)

  // 2. INPUT VALIDATION
  const { filename, contentType, size } = await c.req.json()
  if (!filename || !contentType) return c.json({ error: 'Missing fields' }, 400)

  // 3. GENERATE UNIQUE FILE PATH
  // Path: org_id/raw/random_id/filename.mp4
  const fileId = crypto.randomUUID()
  const key = `${
    session.session.activeOrganizationId || 'org_default'
  }/raw/${fileId}/${filename}`

  // 4. GENERATE PRESIGNED URL (For R2)
  const r2 = new S3Client({
    region: 'auto',
    endpoint: `https://${c.env.ACCOUNT_ID}.r2.cloudflarestorage.com`, // You need to add ACCOUNT_ID to .dev.vars
    credentials: {
      accessKeyId: c.env.R2_ACCESS_KEY_ID,
      secretAccessKey: c.env.R2_SECRET_ACCESS_KEY,
    },
  })

  const command = new PutObjectCommand({
    Bucket: 'vod-raw-dev', // Hardcoded for now, or use c.env.RAW_BUCKET.name if bound differently
    Key: key,
    ContentType: contentType,
    ContentLength: size,
  })

  // The URL is valid for 1 hour
  const url = await getSignedUrl(r2, command, { expiresIn: 3600 })

  return c.json({
    uploadUrl: url,
    fileId: fileId,
    key: key,
  })
})

export default app
