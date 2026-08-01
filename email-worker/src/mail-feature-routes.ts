import { Hono } from 'hono'
import { clientIp } from './api-helpers'
import type { AppContext } from './api'
import {
  downloadBackupObject,
  listBackupObjects,
  runBackupDrill,
} from './backup-browser-api'
import {
  deleteDraftAttachment,
  discardDraft,
  getDraft,
  saveDraft,
  sendDraft,
  uploadDraftAttachment,
} from './draft-api'
import { translateMessage } from './message-translation-api'

export const mailFeatureRoutes = new Hono<AppContext>()

mailFeatureRoutes.get('/admin/backups/objects', (context) => (
  listBackupObjects(context.env, context.get('user'), context.req.raw)
))
mailFeatureRoutes.get('/admin/backups/download', (context) => (
  downloadBackupObject(context.env, context.get('user'), context.req.raw)
))
mailFeatureRoutes.post('/admin/backups/drill', (context) => (
  runBackupDrill(
    context.env,
    context.get('user'),
    context.req.raw,
    clientIp(context.req.raw.headers),
  )
))

mailFeatureRoutes.get('/draft', (context) => (
  getDraft(context.env, context.get('user'))
))
mailFeatureRoutes.put('/draft', (context) => (
  saveDraft(context.env, context.get('user'), context.req.raw)
))
mailFeatureRoutes.delete('/draft', (context) => (
  discardDraft(context.env, context.get('user'))
))
mailFeatureRoutes.post('/draft/attachments', (context) => (
  uploadDraftAttachment(context.env, context.get('user'), context.req.raw)
))
mailFeatureRoutes.delete('/draft/attachments/:id', (context) => (
  deleteDraftAttachment(context.env, context.get('user'), context.req.param('id'))
))
mailFeatureRoutes.post('/draft/send', (context) => (
  sendDraft(
    context.env,
    context.get('user'),
    context.req.raw,
    clientIp(context.req.raw.headers),
  )
))

mailFeatureRoutes.post('/messages/:id/translation', (context) => (
  translateMessage(
    context.env,
    context.get('user'),
    context.req.param('id'),
    context.req.raw,
  )
))
