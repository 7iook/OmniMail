package com.omnimail.android.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.omnimail.android.R
import com.omnimail.android.data.preferences.AppPreferences
import com.omnimail.android.data.preferences.AppLanguage
import com.omnimail.android.data.preferences.ThemePreference
import com.omnimail.android.data.model.MailFolder
import com.omnimail.android.data.model.MailboxScope
import com.omnimail.android.data.model.PageInfo
import com.omnimail.android.data.model.UpdateMessageRequest
import com.omnimail.android.data.repository.ActiveSession
import com.omnimail.android.data.repository.MailRepository
import com.omnimail.android.data.repository.SessionExpiredException
import com.omnimail.android.data.update.AppUpdateChecker
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

class AppViewModel(
    private val repository: MailRepository,
    private val appPreferences: AppPreferences,
    private val deviceName: String,
    private val updateChecker: AppUpdateChecker,
    private val appVersion: String,
) : ViewModel() {
    private val _uiState = MutableStateFlow(
        AppUiState(instanceUrl = repository.lastInstanceUrl(), appVersion = appVersion),
    )
    val uiState: StateFlow<AppUiState> = _uiState.asStateFlow()
    private var messageLoadJob: Job? = null
    private var detailLoadJob: Job? = null
    private var searchDebounceJob: Job? = null
    private val mailComposer = MailComposer(repository)

    init {
        viewModelScope.launch {
            appPreferences.readerPreferences.collect { preferences ->
                _uiState.update { it.copy(readerPreferences = preferences) }
            }
        }
        viewModelScope.launch {
            val session = repository.restoreSession()
            if (session == null) {
                _uiState.update { it.copy(stage = AppStage.Login) }
            } else {
                openSession(session)
            }
        }
    }

    fun updateInstanceUrl(value: String) = _uiState.update {
        it.copy(instanceUrl = value, mfaRequired = false)
    }
    fun updateEmail(value: String) = _uiState.update { it.copy(email = value, mfaRequired = false) }
    fun updatePassword(value: String) = _uiState.update { it.copy(password = value, mfaRequired = false) }
    fun updateMfaCode(value: String) = _uiState.update { it.copy(mfaCode = value) }
    fun dismissMfaChallenge() = _uiState.update { it.copy(mfaCode = "", mfaRequired = false) }
    fun dismissError() = _uiState.update { it.copy(error = null) }
    fun openMail() {
        val returningToMail = _uiState.value.page != AppPage.Mail
        _uiState.update { it.copy(page = AppPage.Mail, profileSaved = false) }
        if (returningToMail) loadMessages()
    }
    fun openProfile() = _uiState.update { it.copy(page = AppPage.Profile, profileSaved = false) }
    fun openSettings() {
        val shouldCheckVersion = _uiState.value.versionCheck is VersionCheckState.NotChecked
        _uiState.update { it.copy(page = AppPage.Settings, profileSaved = false) }
        if (shouldCheckVersion) checkForUpdate()
    }
    fun openComposer() {
        if (!_uiState.value.canComposeNew()) return
        _uiState.update { it.copy(page = AppPage.Compose, composer = mailComposer.newMessage(it)) }
    }
    fun openReply() {
        val state = _uiState.value
        val detail = state.messageDetail ?: return
        if (!state.canSendMail || detail.direction != "incoming" || detail.status != "ready") return
        _uiState.update { it.copy(page = AppPage.Compose, composer = mailComposer.replyTo(detail)) }
    }
    fun closeComposer() = _uiState.update {
        it.copy(page = AppPage.Mail, composer = null, isSending = false)
    }
    fun updateComposerMailbox(value: String) = updateComposer { it.copy(mailboxAddress = value) }
    fun updateComposerTo(value: String) = updateComposer { it.copy(to = value.take(254)) }
    fun updateComposerSubject(value: String) = updateComposer { it.copy(subject = value.take(500)) }
    fun updateComposerText(value: String) = updateComposer { it.copy(text = value.take(50_000)) }
    fun sendComposer() {
        val composer = _uiState.value.composer ?: return
        if (!composer.isReadyToSend() || _uiState.value.isSending) return
        viewModelScope.launch {
            _uiState.update { it.copy(isSending = true, error = null) }
            runCatching { mailComposer.send(composer) }
                .onSuccess {
                    _uiState.update {
                        it.copy(
                            page = AppPage.Mail,
                            composer = null,
                            isSending = false,
                            error = UserMessage.Resource(R.string.message_queued),
                        )
                    }
                    loadMessages()
                }
                .onFailure { error ->
                    if (error is CancellationException) throw error
                    _uiState.update { it.copy(isSending = false, error = userMessage(error)) }
                }
        }
    }
    fun setLoadRemoteImages(enabled: Boolean) = appPreferences.setLoadRemoteImages(enabled)
    fun setConfirmExternalLinks(enabled: Boolean) = appPreferences.setConfirmExternalLinks(enabled)
    fun setTheme(theme: ThemePreference) = appPreferences.setTheme(theme)
    fun setLanguage(language: AppLanguage) = appPreferences.setLanguage(language)

    fun checkForUpdate() {
        if (_uiState.value.versionCheck is VersionCheckState.Checking) return
        viewModelScope.launch {
            _uiState.update { it.copy(versionCheck = VersionCheckState.Checking) }
            runCatching { updateChecker.check(appVersion) }
                .onSuccess { result ->
                    _uiState.update {
                        it.copy(
                            versionCheck = when {
                                result.latestVersion == null -> VersionCheckState.NoRelease
                                result.updateAvailable -> VersionCheckState.UpdateAvailable(
                                    result.latestVersion,
                                    result.releaseUrl.orEmpty(),
                                )
                                else -> VersionCheckState.UpToDate(result.latestVersion)
                            },
                        )
                    }
                }
                .onFailure { error ->
                    if (error is CancellationException) throw error
                    _uiState.update { it.copy(versionCheck = VersionCheckState.Failed) }
                }
        }
    }

    fun login() {
        val state = _uiState.value
        if (state.instanceUrl.isBlank() || state.email.isBlank() || state.password.isBlank()) {
            _uiState.update { it.copy(error = UserMessage.Resource(R.string.error_login_required)) }
            return
        }
        viewModelScope.launch {
            _uiState.update { it.copy(isWorking = true, error = null) }
            runCatching {
                repository.login(
                    instanceUrl = state.instanceUrl,
                    email = state.email,
                    password = state.password,
                    mfaCode = state.mfaCode,
                    deviceName = deviceName,
                )
            }.onSuccess { session ->
                openSession(session)
            }.onFailure { error ->
                if (error is CancellationException) throw error
                val mfaRequired = requiresMfaChallenge(error, state.mfaCode)
                _uiState.update {
                    it.copy(
                        isWorking = false,
                        mfaRequired = mfaRequired || it.mfaRequired,
                        error = if (mfaRequired) null else userMessage(error),
                    )
                }
            }
        }
    }

    fun logout() {
        viewModelScope.launch {
            _uiState.update { it.copy(isWorking = true, error = null) }
            runCatching { repository.logout() }
            _uiState.update {
                AppUiState(
                    stage = AppStage.Login,
                    instanceUrl = it.instanceUrl,
                    email = it.email,
                    appVersion = appVersion,
                )
            }
        }
    }

    fun selectFolder(folder: MailFolder) {
        searchDebounceJob?.cancel()
        if (_uiState.value.folder == folder) {
            loadMessages()
            return
        }
        _uiState.update {
            it.copy(
                folder = folder,
                messages = emptyList(),
                messagePage = PageInfo(),
                selectedMessageId = null,
                messageDetail = null,
                isRefreshing = false,
                isLoadingMore = false,
            )
        }
        loadMessages()
    }

    fun selectMailboxScope(scope: MailboxScope) {
        searchDebounceJob?.cancel()
        if (_uiState.value.mailboxScope == scope) {
            loadMessages()
            return
        }
        messageLoadJob?.cancel()
        detailLoadJob?.cancel()
        _uiState.update {
            it.copy(
                mailboxScope = scope,
                messages = emptyList(),
                messagePage = PageInfo(),
                selectedMessageId = null,
                messageDetail = null,
                isRefreshing = false,
                isLoadingMore = false,
                isDetailLoading = false,
            )
        }
        loadMessages()
    }

    fun refresh() {
        searchDebounceJob?.cancel()
        loadMessages()
    }

    fun loadMoreMessages() {
        val state = _uiState.value
        val cursor = state.messagePage.nextCursor ?: return
        if (!state.messagePage.hasMore || state.isLoadingMore || state.isRefreshing) return
        loadMessages(cursor)
    }

    fun updateSearchQuery(value: String) {
        val query = value.take(120)
        if (_uiState.value.searchQuery == query) return
        searchDebounceJob?.cancel()
        messageLoadJob?.cancel()
        detailLoadJob?.cancel()
        _uiState.update {
            it.copy(
                searchQuery = query,
                messages = emptyList(),
                messagePage = PageInfo(),
                selectedMessageId = null,
                messageDetail = null,
                isRefreshing = false,
                isLoadingMore = false,
                isDetailLoading = false,
            )
        }
        if (query.isBlank()) {
            loadMessages()
        } else {
            searchDebounceJob = viewModelScope.launch {
                delay(350)
                loadMessages()
            }
        }
    }

    fun selectMessage(id: String) {
        if (_uiState.value.selectedMessageId == id && _uiState.value.messageDetail != null) return
        detailLoadJob?.cancel()
        _uiState.update {
            it.copy(selectedMessageId = id, messageDetail = null, isDetailLoading = true, error = null)
        }
        detailLoadJob = viewModelScope.launch {
            runCatching { repository.message(id) }
                .onSuccess { response ->
                    val detail = response.message
                    _uiState.update {
                        it.copy(
                            messageDetail = detail,
                            isDetailLoading = false,
                            counts = if (!detail.isRead) {
                                it.counts.copy(unread = (it.counts.unread - 1).coerceAtLeast(0))
                            } else {
                                it.counts
                            },
                            messages = it.messages.map { summary ->
                                if (summary.id == id) summary.copy(isRead = true) else summary
                            },
                        )
                    }
                    if (!detail.isRead) {
                        runCatching {
                            repository.updateMessage(id, UpdateMessageRequest(isRead = true))
                        }
                    }
                }
                .onFailure(::handleOperationFailure)
        }
    }

    fun closeMessage() {
        detailLoadJob?.cancel()
        _uiState.update {
            it.copy(selectedMessageId = null, messageDetail = null, isDetailLoading = false)
        }
    }

    fun toggleStar() {
        val state = _uiState.value
        val id = state.selectedMessageId ?: return
        val current = state.messageDetail?.isStarred
            ?: state.messages.firstOrNull { it.id == id }?.isStarred
            ?: return
        val target = !current
        updateStarLocally(id, target)
        viewModelScope.launch {
            runCatching {
                repository.updateMessage(id, UpdateMessageRequest(isStarred = target))
            }.onFailure { error ->
                updateStarLocally(id, current)
                handleOperationFailure(error)
            }
        }
    }

    fun updateDisplayName(displayName: String) {
        val normalized = displayName.trim()
        if (normalized.isEmpty() || normalized.length > 60) {
            _uiState.update { it.copy(error = UserMessage.Resource(R.string.error_display_name_length)) }
            return
        }
        if (_uiState.value.user?.displayName == normalized) return
        viewModelScope.launch {
            _uiState.update { it.copy(isProfileSaving = true, profileSaved = false, error = null) }
            runCatching { repository.updateDisplayName(normalized) }
                .onSuccess { user ->
                    _uiState.update {
                        it.copy(user = user, isProfileSaving = false, profileSaved = true)
                    }
                }
                .onFailure { error ->
                    if (error is CancellationException) throw error
                    _uiState.update {
                        it.copy(
                            isProfileSaving = false,
                            profileSaved = false,
                            error = userMessage(error),
                        )
                    }
                }
        }
    }

    private suspend fun openSession(session: ActiveSession) {
        _uiState.update {
            it.copy(
                stage = AppStage.Mail,
                page = AppPage.Mail,
                appName = session.appName,
                user = session.user,
                canSendMail = session.replyEnabled && (
                    session.user.role == "super_admin" || session.user.canReply
                ),
                isRefreshing = true,
                password = "",
                mfaCode = "",
                isWorking = false,
                error = null,
            )
        }
        loadMessages()
        runCatching { repository.mailboxes() }
            .onSuccess { mailboxes -> _uiState.update { it.copy(mailboxes = mailboxes) } }
            .onFailure(::handleOperationFailure)
    }

    private fun loadMessages(cursor: String? = null) {
        messageLoadJob?.cancel()
        val folder = _uiState.value.folder
        val query = _uiState.value.searchQuery
        val mailboxScope = _uiState.value.mailboxScope
        messageLoadJob = viewModelScope.launch {
            _uiState.update {
                if (cursor == null) {
                    it.copy(isRefreshing = true, isLoadingMore = false, error = null)
                } else {
                    it.copy(isLoadingMore = true, error = null)
                }
            }
            runCatching { repository.messages(folder, query.trim(), mailboxScope, cursor) }
                .onSuccess { response ->
                    _uiState.update { current ->
                        if (
                            current.folder != folder ||
                            current.searchQuery != query ||
                            current.mailboxScope != mailboxScope
                        ) {
                            current
                        } else {
                            current.copy(
                                messages = if (cursor == null) {
                                    response.messages
                                } else {
                                    (current.messages + response.messages).distinctBy { it.id }
                                },
                                counts = response.counts,
                                messagePage = response.page,
                                isRefreshing = false,
                                isLoadingMore = false,
                            )
                        }
                    }
                }
                .onFailure(::handleOperationFailure)
        }
    }

    private fun updateStarLocally(id: String, isStarred: Boolean) {
        _uiState.update {
            it.copy(
                messages = it.messages.map { summary ->
                    if (summary.id == id) summary.copy(isStarred = isStarred) else summary
                },
                messageDetail = it.messageDetail?.let { detail ->
                    if (detail.id == id) detail.copy(isStarred = isStarred) else detail
                },
            )
        }
    }

    private fun updateComposer(update: (ComposerState) -> ComposerState) = _uiState.update {
        it.copy(composer = it.composer?.let(update))
    }

    private fun handleOperationFailure(error: Throwable) {
        if (error is CancellationException) return
        if (error is SessionExpiredException) {
            _uiState.update {
                AppUiState(
                    stage = AppStage.Login,
                    instanceUrl = it.instanceUrl,
                    email = it.email,
                    appVersion = appVersion,
                    error = UserMessage.Resource(R.string.error_session_expired),
                )
            }
        } else {
            _uiState.update {
                it.copy(
                    isRefreshing = false,
                    isLoadingMore = false,
                    isDetailLoading = false,
                    error = userMessage(error),
                )
            }
        }
    }

}
