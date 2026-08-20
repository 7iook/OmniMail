import { Hono } from 'hono'
import type { AppContext } from './api'
import { systemVersion } from './system-version'

export const systemVersionRoutes = new Hono<AppContext>()

systemVersionRoutes.get('/admin/version', (context) => (
  systemVersion(context.env, context.get('user'))
))
