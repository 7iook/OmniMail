import { AlertCircle, LoaderCircle, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { api, type ICloudAccount, type ICloudAlias } from '../lib/api'
import { errorMessage } from '../lib/errorMessage'
import { t } from '../lib/i18n'

const MAX_ALIASES = 5
const labelPresets = ['购物', '社交', '订阅', '工作', '临时使用'] as const

type AliasDraft = {
  id: string
  label: string
  email: string
  previewId: string
  loading: boolean
  error: string
}

type CreatedAlias = Pick<ICloudAlias, 'email' | 'label' | 'createdAt'>

function newDraft(): AliasDraft {
  return {
    id: crypto.randomUUID(), label: '', email: '', previewId: '',
    loading: false, error: '',
  }
}

function Spinner() {
  return <LoaderCircle className="spin" size={15} aria-hidden="true" />
}

export function ICloudAliasBatchForm({ account, close, onCreated }: {
  account: ICloudAccount
  close: () => void
  onCreated: (aliases: CreatedAlias[]) => Promise<void>
}) {
  const initialDraft = useRef(newDraft()).current
  const [drafts, setDrafts] = useState<AliasDraft[]>([initialDraft])
  const [activeDraftId, setActiveDraftId] = useState(initialDraft.id)
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState('')
  const previewVersions = useRef(new Map<string, number>())
  const previewBusy = drafts.some((draft) => draft.loading)
  const ready = drafts.every((draft) => draft.email && draft.previewId && !draft.loading)
  const activeDraft = drafts.find((draft) => draft.id === activeDraftId) || drafts[0]

  function updateDraft(id: string, update: Partial<AliasDraft>) {
    setDrafts((items) => items.map((item) => item.id === id ? { ...item, ...update } : item))
  }

  async function previewDraft(id: string) {
    const version = (previewVersions.current.get(id) || 0) + 1
    previewVersions.current.set(id, version)
    updateDraft(id, { loading: true, error: '' })
    try {
      const result = await api.previewICloudAlias(account.id)
      if (previewVersions.current.get(id) === version) {
        updateDraft(id, { email: result.email, previewId: result.previewId })
      }
    } catch (previewError) {
      if (previewVersions.current.get(id) === version) {
        updateDraft(id, { error: errorMessage(previewError) })
      }
    } finally {
      if (previewVersions.current.get(id) === version) updateDraft(id, { loading: false })
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => void previewDraft(initialDraft.id), 0)
    return () => {
      window.clearTimeout(timer)
      for (const [id, version] of previewVersions.current) {
        previewVersions.current.set(id, version + 1)
      }
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  function addDraft() {
    if (drafts.length >= MAX_ALIASES || previewBusy || creating) return
    const draft = newDraft()
    setDrafts((items) => [...items, draft])
    setActiveDraftId(draft.id)
    void previewDraft(draft.id)
  }

  function removeDraft(id: string) {
    if (drafts.length === 1 || creating) return
    previewVersions.current.set(id, (previewVersions.current.get(id) || 0) + 1)
    const remaining = drafts.filter((draft) => draft.id !== id)
    setDrafts(remaining)
    if (activeDraftId === id) setActiveDraftId(remaining[0].id)
  }

  function setLabel(id: string, label: string) {
    updateDraft(id, { label: label.slice(0, 80) })
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (creating || !ready) return
    setCreating(true); setCreateError('')
    const snapshot = drafts
    const created: CreatedAlias[] = []
    let failure: unknown = null
    let failedAt = snapshot.length
    for (let index = 0; index < snapshot.length; index += 1) {
      const draft = snapshot[index]
      try {
        const result = await api.createICloudAlias(
          account.id, draft.label, draft.email, draft.previewId,
        )
        created.push(result.alias)
      } catch (submitError) {
        failure = submitError; failedAt = index; break
      }
    }
    if (failure) {
      if (created.length) {
        const remaining = snapshot.slice(failedAt)
        setDrafts(remaining); setActiveDraftId(remaining[0].id)
        await onCreated(created)
        setCreateError(t('已创建 {count} 个，剩余项目未创建：{error}', {
          count: created.length, error: errorMessage(failure),
        }))
      } else {
        setCreateError(errorMessage(failure))
      }
      setCreating(false)
      return
    }
    await onCreated(created)
    setCreating(false)
    close()
  }

  return (
    <form className="icloud-form icloud-alias-batch-form"
      onSubmit={(event) => void submit(event)}>
      <div className="icloud-alias-batch-toolbar">
        <span>{t('创建项目')} <strong>{drafts.length}/5</strong></span>
        <button className="button button--secondary" type="button"
          disabled={drafts.length >= MAX_ALIASES || previewBusy || creating}
          onClick={addDraft}><Plus size={15} />{t('添加一个')}</button>
      </div>
      <div className="icloud-alias-drafts">
        {drafts.map((draft, index) => (
          <section className="icloud-alias-preview" key={draft.id}
            role="group" aria-labelledby={`icloud-alias-draft-${draft.id}`}
            aria-busy={draft.loading}>
            <div>
              <span id={`icloud-alias-draft-${draft.id}`}>{t('隐藏邮箱 {index}', { index: index + 1 })}</span>
              <span className="icloud-alias-preview-actions">
                <button className="icloud-alias-draft-action" type="button"
                  disabled={previewBusy || creating}
                  aria-label={t('为隐藏邮箱 {index} 换一个地址', { index: index + 1 })}
                  data-tooltip={t('换一个')}
                  onClick={() => void previewDraft(draft.id)}>
                  {draft.loading ? <Spinner /> : <RefreshCw size={15} />}
                </button>
                {drafts.length > 1 && <button className="icloud-alias-draft-action is-danger"
                  type="button" disabled={creating}
                  aria-label={t('移除第 {index} 个隐藏邮箱', { index: index + 1 })}
                  data-tooltip={t('移除')}
                  onClick={() => removeDraft(draft.id)}>
                  <Trash2 size={15} />
                </button>}
              </span>
            </div>
            <strong aria-live="polite">{draft.email || t(draft.loading
              ? '正在生成候选地址…' : '暂时无法生成地址')}</strong>
            <label><span>{t('用途标签（可选）')}</span><input value={draft.label}
              maxLength={80} data-modal-autofocus={index === 0 || undefined}
              onFocus={() => setActiveDraftId(draft.id)}
              onChange={(event) => setLabel(draft.id, event.target.value)}
              placeholder={t('留空则由系统自动生成')} /></label>
            {draft.error && <small className="inline-error" role="alert">
              <AlertCircle size={15} />{t(draft.error)}
            </small>}
          </section>
        ))}
      </div>
      <div className="icloud-label-presets" role="group" aria-label={t('快捷用途标签')}>
        <button type="button" disabled={creating} aria-pressed={!activeDraft?.label}
          onClick={() => activeDraft && setLabel(activeDraft.id, '')}>{t('自动生成')}</button>
        {labelPresets.map((preset) => <button type="button" key={preset} disabled={creating}
          aria-pressed={activeDraft?.label === t(preset)}
          onClick={() => activeDraft && setLabel(activeDraft.id, t(preset))}>{t(preset)}</button>)}
      </div>
      <p className="icloud-form-note">{t('每个项目可填写独立标签；一次最多创建 5 个隐藏邮箱。')}</p>
      {createError && <p className="inline-error" role="alert">
        <AlertCircle size={15} />{t(createError)}
      </p>}
      <footer>
        <button className="button button--secondary" type="button" disabled={creating}
          onClick={close}>{t('取消')}</button>
        <button className="button button--primary" disabled={creating || !ready}>
          {creating ? <Spinner /> : <Plus size={15} />}
          {t('创建 {count} 个', { count: drafts.length })}
        </button>
      </footer>
    </form>
  )
}
