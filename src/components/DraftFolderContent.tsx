import { AlertCircle } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { api, type DraftSummary, type MailboxAddress } from '../lib/api'
import { errorMessage } from '../lib/errorMessage'
import { ComposeDialog } from './ComposeDialog'
import { DraftList } from './DraftList'

export function DraftFolderContent({
  mailboxes,
  initialMailbox,
  active,
  composeRequest,
  refreshRequest,
  onCountChange,
  onSent,
}: {
  mailboxes: MailboxAddress[]
  initialMailbox: string
  active: boolean
  composeRequest: number
  refreshRequest: number
  onCountChange: (count: number) => void
  onSent: () => void
}) {
  const [drafts, setDrafts] = useState<DraftSummary[]>([])
  const [limit, setLimit] = useState(5)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [openDraftId, setOpenDraftId] = useState<string | null | undefined>()

  const loadDrafts = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const result = await api.drafts()
      setDrafts(result.drafts)
      setLimit(result.limit)
      onCountChange(result.drafts.length)
    } catch (loadError) {
      setError(errorMessage(loadError))
    } finally {
      setLoading(false)
    }
  }, [onCountChange])

  useEffect(() => {
    if (active) void loadDrafts()
  }, [active, loadDrafts, refreshRequest])

  useEffect(() => {
    if (composeRequest > 0) setOpenDraftId(null)
  }, [composeRequest])

  async function deleteDraft(draft: DraftSummary) {
    await api.discardDraft(draft.id)
    await loadDrafts()
  }

  return <>
    {active && error && <p className="list-error" role="alert"><AlertCircle size={15} />{error}</p>}
    {active && <DraftList
      drafts={drafts}
      limit={limit}
      loading={loading}
      onOpen={(draft) => setOpenDraftId(draft.id)}
      onDelete={deleteDraft}
    />}
    {openDraftId !== undefined && (
      <ComposeDialog
        key={openDraftId ?? `new-${composeRequest}`}
        mailboxes={mailboxes}
        initialMailbox={initialMailbox}
        draftId={openDraftId}
        onDraftChanged={() => void loadDrafts()}
        onClose={() => { setOpenDraftId(undefined); void loadDrafts() }}
        onSent={() => { setOpenDraftId(undefined); void loadDrafts(); onSent() }}
      />
    )}
  </>
}
