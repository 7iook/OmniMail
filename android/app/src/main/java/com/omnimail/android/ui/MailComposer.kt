package com.omnimail.android.ui

import com.omnimail.android.data.model.MailboxScope
import com.omnimail.android.data.model.MessageDetail
import com.omnimail.android.data.model.ReplyRequest
import com.omnimail.android.data.model.SendMessageRequest
import com.omnimail.android.data.repository.MailRepository
import java.util.UUID

internal class MailComposer(private val repository: MailRepository) {
    fun newMessage(state: AppUiState): ComposerState {
        val activeMailboxes = state.mailboxes.filter { it.isActive }
        val selectedAddress = (state.mailboxScope as? MailboxScope.Mailbox)?.value
        val mailbox = activeMailboxes.firstOrNull { it.address == selectedAddress }
            ?: activeMailboxes.firstOrNull { it.isPrimary }
            ?: activeMailboxes.firstOrNull()
        return ComposerState(
            mailboxAddress = mailbox?.address.orEmpty(),
            idempotencyKey = requestId(),
        )
    }

    fun replyTo(detail: MessageDetail): ComposerState = ComposerState(
        replyMessageId = detail.id,
        mailboxAddress = detail.mailboxAddress,
        to = detail.senderAddress,
        subject = replySubject(detail.subject),
        idempotencyKey = requestId(),
    )

    suspend fun send(composer: ComposerState) {
        val replyMessageId = composer.replyMessageId
        if (replyMessageId != null) {
            repository.reply(
                replyMessageId,
                ReplyRequest(composer.text.trim(), composer.idempotencyKey),
            )
        } else {
            repository.sendMessage(
                SendMessageRequest(
                    mailboxAddress = composer.mailboxAddress,
                    to = composer.to.trim(),
                    subject = composer.subject.trim(),
                    text = composer.text.trim(),
                    idempotencyKey = composer.idempotencyKey,
                ),
            )
        }
    }

    private fun requestId(): String = UUID.randomUUID().toString().replace("-", "")

    private fun replySubject(subject: String): String {
        val normalized = subject.trim()
        return if (normalized.startsWith("Re:", ignoreCase = true)) normalized else "Re: $normalized"
    }
}

internal fun ComposerState.isReadyToSend(): Boolean = text.isNotBlank() && (
    replyMessageId != null ||
        (mailboxAddress.isNotBlank() && to.isNotBlank() && subject.isNotBlank())
)

internal fun AppUiState.canComposeNew(): Boolean = canSendMail && mailboxes.any { it.isActive }
