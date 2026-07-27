import { fetchApi } from './api'
import { cleanup } from './cleanup'
import { consumeEmailQueue, receiveEmail } from './mail'
import type { Env, ParseJob } from './types'

export default {
  fetch: fetchApi,
  email: receiveEmail,
  queue: consumeEmailQueue,
  scheduled: (_controller, env) => cleanup(env),
} satisfies ExportedHandler<Env, ParseJob>
