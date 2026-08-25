import { Hono } from 'hono'
import type { AppContext } from './context'
import { registerMiddleware } from './middleware/register-middleware'
import { registerAccountRoutes } from './routes/account-routes'
import { registerAdminRoutes } from './routes/admin-routes'
import { registerMailRoutes } from './routes/mail-routes'
import { registerPublicRoutes } from './routes/public-routes'

const app = new Hono<AppContext>()

registerMiddleware(app)
registerPublicRoutes(app)
registerAccountRoutes(app)
registerAdminRoutes(app)
registerMailRoutes(app)

app.onError((error, context) => {
  console.error(error)
  return context.json({ error: '服务器暂时无法处理这个请求。' }, 500)
})

app.notFound((context) => context.json({ error: '接口不存在。' }, 404))

export const fetchApi = app.fetch
