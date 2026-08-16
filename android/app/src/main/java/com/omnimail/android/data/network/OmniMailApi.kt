package com.omnimail.android.data.network

import com.omnimail.android.data.model.ErrorResponse
import com.omnimail.android.data.model.BulkMessageRequest
import com.omnimail.android.data.model.AccountUpdateRequest
import com.omnimail.android.data.model.AccountUpdateResponse
import com.omnimail.android.data.model.InstanceConfig
import com.omnimail.android.data.model.MailFolder
import com.omnimail.android.data.model.MailboxesResponse
import com.omnimail.android.data.model.MailboxScope
import com.omnimail.android.data.model.MessageDetailResponse
import com.omnimail.android.data.model.MessagesResponse
import com.omnimail.android.data.model.OkResponse
import com.omnimail.android.data.model.OutboundMessageResponse
import com.omnimail.android.data.model.RefreshTokenRequest
import com.omnimail.android.data.model.ReplyRequest
import com.omnimail.android.data.model.SendMessageRequest
import com.omnimail.android.data.model.TokenRequest
import com.omnimail.android.data.model.TokenResponse
import com.omnimail.android.data.model.UpdateMessageRequest
import java.net.URLEncoder
import java.nio.charset.StandardCharsets
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.CacheControl
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

enum class ApiErrorKind { ServerMessage, RequestFailed, IncompatibleResponse }

class ApiException(
    val status: Int,
    override val message: String,
    val kind: ApiErrorKind = ApiErrorKind.ServerMessage,
) : Exception(message)

interface OmniMailService {
    suspend fun config(baseUrl: String): InstanceConfig
    suspend fun issueToken(baseUrl: String, request: TokenRequest): TokenResponse
    suspend fun refreshToken(baseUrl: String, refreshToken: String): TokenResponse
    suspend fun revokeToken(baseUrl: String, refreshToken: String): OkResponse
    suspend fun mailboxes(baseUrl: String, accessToken: String): MailboxesResponse
    suspend fun messages(
        baseUrl: String,
        accessToken: String,
        folder: MailFolder,
        query: String,
        scope: MailboxScope,
        cursor: String?,
    ): MessagesResponse
    suspend fun message(baseUrl: String, accessToken: String, id: String): MessageDetailResponse
    suspend fun updateMessage(
        baseUrl: String,
        accessToken: String,
        id: String,
        update: UpdateMessageRequest,
    ): OkResponse
    suspend fun updateMessages(
        baseUrl: String,
        accessToken: String,
        update: BulkMessageRequest,
    ): OkResponse
    suspend fun updateAccount(
        baseUrl: String,
        accessToken: String,
        update: AccountUpdateRequest,
    ): AccountUpdateResponse
    suspend fun sendMessage(
        baseUrl: String,
        accessToken: String,
        message: SendMessageRequest,
    ): OutboundMessageResponse
    suspend fun reply(
        baseUrl: String,
        accessToken: String,
        id: String,
        reply: ReplyRequest,
    ): OutboundMessageResponse
}

class OmniMailApi(
    private val client: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .build(),
) : OmniMailService {
    private val json = Json {
        ignoreUnknownKeys = true
        explicitNulls = false
    }
    private val jsonMediaType = "application/json; charset=utf-8".toMediaType()

    override suspend fun config(baseUrl: String): InstanceConfig =
        request(baseUrl, "/api/config")

    override suspend fun issueToken(baseUrl: String, request: TokenRequest): TokenResponse =
        request(baseUrl, "/api/auth/token", "POST", body = json.encodeToString(request))

    override suspend fun refreshToken(baseUrl: String, refreshToken: String): TokenResponse =
        request(
            baseUrl,
            "/api/auth/token/refresh",
            "POST",
            body = json.encodeToString(RefreshTokenRequest(refreshToken)),
        )

    override suspend fun revokeToken(baseUrl: String, refreshToken: String): OkResponse =
        request(
            baseUrl,
            "/api/auth/token/revoke",
            "POST",
            body = json.encodeToString(RefreshTokenRequest(refreshToken)),
        )

    override suspend fun mailboxes(baseUrl: String, accessToken: String): MailboxesResponse =
        request(baseUrl, "/api/mailboxes", accessToken = accessToken)

    override suspend fun messages(
        baseUrl: String,
        accessToken: String,
        folder: MailFolder,
        query: String,
        scope: MailboxScope,
        cursor: String?,
    ): MessagesResponse = request(
        baseUrl,
        buildString {
            append("/api/messages?folder=${folder.apiValue}&limit=30")
            query.trim().take(120).takeIf(String::isNotEmpty)?.let {
                append("&q=")
                append(encodePathSegment(it))
            }
            when (scope) {
                MailboxScope.All -> Unit
                is MailboxScope.Domain -> append("&domain=${encodePathSegment(scope.value)}")
                is MailboxScope.Mailbox -> append("&mailbox=${encodePathSegment(scope.value)}")
            }
            cursor?.takeIf(String::isNotBlank)?.let {
                append("&cursor=")
                append(encodePathSegment(it))
            }
        },
        accessToken = accessToken,
    )

    override suspend fun message(
        baseUrl: String,
        accessToken: String,
        id: String,
    ): MessageDetailResponse = request(
        baseUrl,
        "/api/messages/${encodePathSegment(id)}",
        accessToken = accessToken,
    )

    override suspend fun updateMessage(
        baseUrl: String,
        accessToken: String,
        id: String,
        update: UpdateMessageRequest,
    ): OkResponse = request(
        baseUrl,
        "/api/messages/${encodePathSegment(id)}",
        method = "PATCH",
        accessToken = accessToken,
        body = json.encodeToString(update),
    )

    override suspend fun updateMessages(
        baseUrl: String,
        accessToken: String,
        update: BulkMessageRequest,
    ): OkResponse = request(
        baseUrl,
        "/api/messages/bulk",
        method = "PATCH",
        accessToken = accessToken,
        body = json.encodeToString(update),
    )

    override suspend fun updateAccount(
        baseUrl: String,
        accessToken: String,
        update: AccountUpdateRequest,
    ): AccountUpdateResponse = request(
        baseUrl,
        "/api/account",
        method = "PATCH",
        accessToken = accessToken,
        body = json.encodeToString(update),
    )

    override suspend fun sendMessage(
        baseUrl: String,
        accessToken: String,
        message: SendMessageRequest,
    ): OutboundMessageResponse = request(
        baseUrl,
        "/api/messages",
        method = "POST",
        accessToken = accessToken,
        body = json.encodeToString(message),
    )

    override suspend fun reply(
        baseUrl: String,
        accessToken: String,
        id: String,
        reply: ReplyRequest,
    ): OutboundMessageResponse = request(
        baseUrl,
        "/api/messages/${encodePathSegment(id)}/reply",
        method = "POST",
        accessToken = accessToken,
        body = json.encodeToString(reply),
    )

    private suspend inline fun <reified T> request(
        baseUrl: String,
        path: String,
        method: String = "GET",
        accessToken: String? = null,
        body: String? = null,
    ): T = withContext(Dispatchers.IO) {
        val requestBody = body?.toRequestBody(jsonMediaType)
        val builder = Request.Builder()
            .url("$baseUrl$path")
            .method(method, requestBody)
            .header("Accept", "application/json")
        if (method == "GET") builder.cacheControl(CacheControl.FORCE_NETWORK)
        if (accessToken != null) builder.header("Authorization", "Bearer $accessToken")

        client.newCall(builder.build()).execute().use { response ->
            val responseBody = response.body.string()
            if (!response.isSuccessful) {
                val apiMessage = runCatching {
                    json.decodeFromString<ErrorResponse>(responseBody).error
                }.getOrNull()
                throw ApiException(
                    response.code,
                    apiMessage.orEmpty(),
                    if (apiMessage.isNullOrBlank()) ApiErrorKind.RequestFailed else ApiErrorKind.ServerMessage,
                )
            }
            runCatching { json.decodeFromString<T>(responseBody) }
                .getOrElse {
                    throw ApiException(
                        response.code,
                        "Incompatible server response",
                        ApiErrorKind.IncompatibleResponse,
                    )
                }
        }
    }

    private fun encodePathSegment(value: String): String =
        URLEncoder.encode(value, StandardCharsets.UTF_8.name()).replace("+", "%20")
}
