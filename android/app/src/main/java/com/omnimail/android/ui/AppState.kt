package com.omnimail.android.ui

import androidx.annotation.StringRes
import com.omnimail.android.data.model.MailCounts
import com.omnimail.android.data.model.MailFolder
import com.omnimail.android.data.model.MailboxAddress
import com.omnimail.android.data.model.MailboxScope
import com.omnimail.android.data.model.MessageDetail
import com.omnimail.android.data.model.MessageSummary
import com.omnimail.android.data.model.PageInfo
import com.omnimail.android.data.model.SessionUser
import com.omnimail.android.data.preferences.ReaderPreferences

enum class AppStage { Restoring, Login, Mail }
enum class AppPage { Mail, Compose, Profile, Settings }

data class ComposerState(
    val replyMessageId: String? = null,
    val mailboxAddress: String = "",
    val to: String = "",
    val subject: String = "",
    val text: String = "",
    val idempotencyKey: String = "",
)

sealed interface VersionCheckState {
    data object NotChecked : VersionCheckState
    data object Checking : VersionCheckState
    data object NoRelease : VersionCheckState
    data object Failed : VersionCheckState
    data class UpToDate(val latestVersion: String) : VersionCheckState
    data class UpdateAvailable(val latestVersion: String, val releaseUrl: String) : VersionCheckState
}

data class AppUiState(
    val stage: AppStage = AppStage.Restoring,
    val page: AppPage = AppPage.Mail,
    val instanceUrl: String = "",
    val email: String = "",
    val password: String = "",
    val mfaCode: String = "",
    val mfaRequired: Boolean = false,
    val appName: String = "OmniMail",
    val appVersion: String = "",
    val user: SessionUser? = null,
    val canSendMail: Boolean = false,
    val folder: MailFolder = MailFolder.Inbox,
    val mailboxes: List<MailboxAddress> = emptyList(),
    val mailboxScope: MailboxScope = MailboxScope.All,
    val counts: MailCounts = MailCounts(),
    val messages: List<MessageSummary> = emptyList(),
    val messagePage: PageInfo = PageInfo(),
    val searchQuery: String = "",
    val selectedMessageId: String? = null,
    val messageDetail: MessageDetail? = null,
    val isWorking: Boolean = false,
    val isRefreshing: Boolean = false,
    val isLoadingMore: Boolean = false,
    val isDetailLoading: Boolean = false,
    val composer: ComposerState? = null,
    val isSending: Boolean = false,
    val isProfileSaving: Boolean = false,
    val profileSaved: Boolean = false,
    val readerPreferences: ReaderPreferences = ReaderPreferences(),
    val versionCheck: VersionCheckState = VersionCheckState.NotChecked,
    val error: UserMessage? = null,
)

sealed interface UserMessage {
    data class Resource(
        @param:StringRes val id: Int,
        val args: List<Any> = emptyList(),
    ) : UserMessage

    data class Text(val value: String) : UserMessage
}
