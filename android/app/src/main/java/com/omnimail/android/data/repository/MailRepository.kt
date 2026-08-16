package com.omnimail.android.data.repository

import com.omnimail.android.BuildConfig
import com.omnimail.android.data.model.MailFolder
import com.omnimail.android.data.model.AccountUpdateRequest
import com.omnimail.android.data.model.MailboxAddress
import com.omnimail.android.data.model.MailboxScope
import com.omnimail.android.data.model.MessageDetailResponse
import com.omnimail.android.data.model.MessagesResponse
import com.omnimail.android.data.model.OutboundMessageResponse
import com.omnimail.android.data.model.ReplyRequest
import com.omnimail.android.data.model.SendMessageRequest
import com.omnimail.android.data.model.SessionUser
import com.omnimail.android.data.model.TokenRequest
import com.omnimail.android.data.model.UpdateMessageRequest
import com.omnimail.android.data.network.ApiException
import com.omnimail.android.data.network.OmniMailService
import com.omnimail.android.data.network.normalizeInstanceUrl
import com.omnimail.android.data.security.SessionStore
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

data class ActiveSession(
    val baseUrl: String,
    val user: SessionUser,
    val appName: String = "OmniMail",
    val replyEnabled: Boolean = false,
)

class SessionExpiredException : Exception("Session expired")

class MailRepository(
    private val service: OmniMailService,
    private val sessionStore: SessionStore,
    private val allowLocalHttp: Boolean = BuildConfig.DEBUG,
) {
    private val refreshMutex = Mutex()
    @Volatile private var accessToken: String? = null
    @Volatile private var activeSession: ActiveSession? = null

    fun lastInstanceUrl(): String = sessionStore.lastInstanceUrl()

    suspend fun login(
        instanceUrl: String,
        email: String,
        password: String,
        mfaCode: String,
        deviceName: String,
    ): ActiveSession {
        val baseUrl = normalizeInstanceUrl(instanceUrl, allowLocalHttp)
        val config = service.config(baseUrl)
        require(config.setupComplete) { "The OmniMail instance has not completed setup." }
        val response = service.issueToken(
            baseUrl,
            TokenRequest(
                email = email.trim(),
                password = password,
                deviceName = deviceName,
                mfaCode = mfaCode.trim().ifEmpty { null },
            ),
        )
        sessionStore.save(baseUrl, response.refreshToken)
        accessToken = response.accessToken
        return ActiveSession(baseUrl, response.user, config.appName, config.replyEnabled)
            .also { activeSession = it }
    }

    suspend fun restoreSession(): ActiveSession? {
        val stored = sessionStore.load() ?: return null
        val response = try {
            service.refreshToken(stored.baseUrl, stored.refreshToken)
        } catch (error: Exception) {
            if (error is ApiException && error.status == 401) sessionStore.clear()
            return null
        }
        return try {
            sessionStore.save(stored.baseUrl, response.refreshToken)
            accessToken = response.accessToken
            val config = runCatching { service.config(stored.baseUrl) }.getOrNull()
            ActiveSession(
                stored.baseUrl,
                response.user,
                config?.appName ?: "OmniMail",
                config?.replyEnabled ?: false,
            )
                .also { activeSession = it }
        } catch (_: Exception) {
            accessToken = null
            activeSession = null
            sessionStore.clear()
            null
        }
    }

    suspend fun logout() {
        val stored = sessionStore.load()
        try {
            if (stored != null) service.revokeToken(stored.baseUrl, stored.refreshToken)
        } finally {
            accessToken = null
            activeSession = null
            sessionStore.clear()
        }
    }

    suspend fun mailboxes(): List<MailboxAddress> = authorized { baseUrl, token ->
        service.mailboxes(baseUrl, token).mailboxes
    }

    suspend fun messages(
        folder: MailFolder,
        query: String = "",
        scope: MailboxScope = MailboxScope.All,
        cursor: String? = null,
    ): MessagesResponse = authorized { baseUrl, token ->
        service.messages(baseUrl, token, folder, query, scope, cursor)
    }

    suspend fun message(id: String): MessageDetailResponse = authorized { baseUrl, token ->
        service.message(baseUrl, token, id)
    }

    suspend fun updateMessage(id: String, update: UpdateMessageRequest) {
        authorized { baseUrl, token -> service.updateMessage(baseUrl, token, id, update) }
    }

    suspend fun sendMessage(message: SendMessageRequest): OutboundMessageResponse =
        authorized { baseUrl, token -> service.sendMessage(baseUrl, token, message) }

    suspend fun reply(id: String, reply: ReplyRequest): OutboundMessageResponse =
        authorized { baseUrl, token -> service.reply(baseUrl, token, id, reply) }

    suspend fun updateDisplayName(displayName: String): SessionUser = authorized { baseUrl, token ->
        service.updateAccount(baseUrl, token, AccountUpdateRequest(displayName)).user
    }.also { user ->
        activeSession = activeSession?.copy(user = user)
    }

    private suspend fun <T> authorized(block: suspend (String, String) -> T): T {
        val session = activeSession ?: throw SessionExpiredException()
        val originalToken = accessToken ?: throw SessionExpiredException()
        return try {
            block(session.baseUrl, originalToken)
        } catch (error: ApiException) {
            if (error.status != 401) throw error
            val refreshedToken = refreshAccessToken(originalToken)
            try {
                block(session.baseUrl, refreshedToken)
            } catch (retryError: ApiException) {
                if (retryError.status != 401) throw retryError
                accessToken = null
                activeSession = null
                sessionStore.clear()
                throw SessionExpiredException()
            }
        }
    }

    private suspend fun refreshAccessToken(failedToken: String): String = refreshMutex.withLock {
        accessToken?.takeIf { it != failedToken }?.let { return@withLock it }
        val stored = sessionStore.load() ?: throw SessionExpiredException()
        val response = try {
            service.refreshToken(stored.baseUrl, stored.refreshToken)
        } catch (error: Exception) {
            if (error !is ApiException || error.status != 401) throw error
            accessToken = null
            activeSession = null
            sessionStore.clear()
            throw SessionExpiredException()
        }
        try {
            sessionStore.save(stored.baseUrl, response.refreshToken)
            accessToken = response.accessToken
            activeSession = activeSession?.copy(user = response.user)
            response.accessToken
        } catch (_: Exception) {
            accessToken = null
            activeSession = null
            sessionStore.clear()
            throw SessionExpiredException()
        }
    }
}
