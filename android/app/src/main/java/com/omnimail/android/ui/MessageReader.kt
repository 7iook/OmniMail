package com.omnimail.android.ui

import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.IconButton
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.omnimail.android.R
import com.omnimail.android.data.model.MessageDetail
import com.omnimail.android.ui.components.AppIcon
import com.omnimail.android.ui.components.LineIcon
import com.omnimail.android.ui.components.SafeEmailWebView
import com.omnimail.android.ui.components.openExternalUrl
import com.omnimail.android.ui.theme.EmailNavigationBarAppearance
import kotlinx.coroutines.delay

@Composable
internal fun MessageReader(
    state: AppUiState,
    onToggleStar: () -> Unit,
    modifier: Modifier = Modifier,
    onBack: (() -> Unit)? = null,
    onReply: (() -> Unit)? = null,
    onForward: (() -> Unit)? = null,
) {
    val detail = state.messageDetail
    when {
        state.selectedMessageId == null -> EmptyPane(
            title = stringResource(R.string.select_mail_title),
            detail = stringResource(R.string.select_mail_detail),
            modifier = modifier,
        )
        state.isDetailLoading || detail == null -> Box(
            modifier.fillMaxSize(),
            contentAlignment = Alignment.Center,
        ) {
            CircularProgressIndicator()
        }
        else -> MessageDetailContent(
            detail = detail,
            onBack = onBack,
            onToggleStar = onToggleStar,
            onReply = onReply?.takeIf {
                state.canSendMail && detail.direction == "incoming" && detail.status == "ready"
            },
            onForward = onForward?.takeIf {
                state.canComposeNew() && detail.status == "ready"
            },
            loadRemoteImages = state.readerPreferences.loadRemoteImages,
            confirmExternalLinks = state.readerPreferences.confirmExternalLinks,
            modifier = modifier,
        )
    }
}

@Composable
private fun MessageDetailContent(
    detail: MessageDetail,
    onBack: (() -> Unit)?,
    onToggleStar: () -> Unit,
    onReply: (() -> Unit)?,
    onForward: (() -> Unit)?,
    loadRemoteImages: Boolean,
    confirmExternalLinks: Boolean,
    modifier: Modifier,
) {
    val motionEnabled = mailMotionEnabled()
    val darkTheme = MaterialTheme.colorScheme.background.luminance() < 0.5f
    val context = LocalContext.current
    val locale = LocalConfiguration.current.locales[0]
    val linkLabel = stringResource(R.string.link_placeholder)
    val emptyBody = stringResource(R.string.empty_message_body)
    val starredStateDescription = stringResource(R.string.starred_state)
    val notStarredStateDescription = stringResource(R.string.not_starred_state)
    val emailStrings = EmailChromeStrings(
        noSubject = stringResource(R.string.no_subject),
        unknownSender = stringResource(R.string.unknown_sender),
        remoteImagesBlocked = stringResource(R.string.remote_images_blocked),
        showImages = stringResource(R.string.show_images),
        sentToFormat = stringResource(R.string.sent_to),
        attachments = stringResource(R.string.attachments),
        attachmentDownloadFuture = stringResource(R.string.attachment_download_future),
    )
    var showRemoteImages by remember(detail.id, loadRemoteImages) { mutableStateOf(loadRemoteImages) }
    var pendingExternalLink by remember(detail.id) { mutableStateOf<String?>(null) }
    var contentScrolled by remember(detail.id) { mutableStateOf(false) }
    val currentStarred by rememberUpdatedState(detail.isStarred)
    var previousStarred by remember(detail.id) { mutableStateOf(detail.isStarred) }
    var starPop by remember(detail.id) { mutableStateOf(false) }

    LaunchedEffect(currentStarred) {
        if (currentStarred != previousStarred) {
            previousStarred = currentStarred
            if (motionEnabled) {
                starPop = true
                delay(120)
                starPop = false
            }
        }
    }
    val starScale by animateFloatAsState(
        targetValue = if (starPop) 1.16f else 1f,
        animationSpec = tween(120, easing = FastOutSlowInEasing),
        label = stringResource(R.string.star_feedback),
    )

    val hasBottomActions = onReply != null || onForward != null
    EmailNavigationBarAppearance(
        darkBackground = darkTheme || (!hasBottomActions &&
            detail.html.isNotBlank() && emailUsesDarkBackground(detail.html)),
    )
    Column(modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
        Row(
            Modifier
                .fillMaxWidth()
                .heightIn(min = 64.dp)
                .padding(horizontal = 8.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (onBack != null) {
                IconButton(onClick = onBack) {
                    LineIcon(AppIcon.Back, stringResource(R.string.back_to_message_list))
                }
            }
            Text(
                if (contentScrolled) {
                    readableMessageText(detail.subject, linkLabel)
                        .ifBlank { stringResource(R.string.no_subject) }
                } else {
                    stringResource(R.string.message_detail)
                },
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold,
                modifier = Modifier.weight(1f).padding(start = if (onBack == null) 12.dp else 0.dp),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            IconButton(
                onClick = onToggleStar,
                colors = IconButtonDefaults.iconButtonColors(
                    contentColor = if (detail.isStarred) {
                        MaterialTheme.colorScheme.tertiary
                    } else {
                        MaterialTheme.colorScheme.onSurfaceVariant
                    },
                ),
                modifier = Modifier.semantics {
                    stateDescription = if (detail.isStarred) {
                        starredStateDescription
                    } else {
                        notStarredStateDescription
                    }
                },
            ) {
                LineIcon(
                    AppIcon.Star,
                    if (detail.isStarred) {
                        stringResource(R.string.remove_star)
                    } else {
                        stringResource(R.string.add_star)
                    },
                    modifier = Modifier.graphicsLayer {
                        scaleX = starScale
                        scaleY = starScale
                    },
                    filled = detail.isStarred,
                )
            }
        }
        HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
        SafeEmailWebView(
            html = detail.html.ifBlank {
                "<div class=\"omnimail-plain-text\">${
                    htmlEscape(readableMessageText(detail.text, linkLabel).ifBlank { emptyBody })
                }</div>"
            },
            loadRemoteImages = showRemoteImages,
            trustedHeaderHtml = messageHeaderHtml(
                detail = detail,
                showRemoteImagesBanner = detail.html.isNotBlank() &&
                    !showRemoteImages && containsRemoteContent(detail.html),
                strings = emailStrings,
                locale = locale,
            ),
            trustedFooterHtml = messageAttachmentsHtml(detail, emailStrings),
            darkTheme = darkTheme,
            modifier = Modifier.weight(1f),
            onScrolledChange = { contentScrolled = it },
            onShowRemoteImages = { showRemoteImages = true },
            onExternalLink = { url ->
                if (confirmExternalLinks) pendingExternalLink = url else openExternalUrl(context, url)
            },
        )
        if (hasBottomActions) {
            MessageActionBar(onReply = onReply, onForward = onForward)
        }
    }
    pendingExternalLink?.let { url ->
        AlertDialog(
            onDismissRequest = { pendingExternalLink = null },
            title = { Text(stringResource(R.string.open_external_link_title)) },
            text = { Text(url, maxLines = 5, overflow = TextOverflow.Ellipsis) },
            confirmButton = {
                Button(onClick = {
                    pendingExternalLink = null
                    openExternalUrl(context, url)
                }) { Text(stringResource(R.string.open_in_browser)) }
            },
            dismissButton = {
                TextButton(onClick = { pendingExternalLink = null }) {
                    Text(stringResource(R.string.cancel))
                }
            },
        )
    }
}

@Composable
private fun MessageActionBar(
    onReply: (() -> Unit)?,
    onForward: (() -> Unit)?,
) {
    Surface(color = MaterialTheme.colorScheme.surface) {
        Column {
            HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
            Row(
                Modifier
                    .fillMaxWidth()
                    .navigationBarsPadding()
                    .padding(horizontal = 16.dp, vertical = 12.dp),
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                onReply?.let {
                    FilledTonalButton(
                        onClick = it,
                        modifier = Modifier.weight(1f).heightIn(min = 52.dp),
                    ) {
                        LineIcon(AppIcon.Reply, null, Modifier.size(20.dp))
                        Spacer(Modifier.width(8.dp))
                        Text(stringResource(R.string.reply_action))
                    }
                }
                onForward?.let {
                    FilledTonalButton(
                        onClick = it,
                        modifier = Modifier.weight(1f).heightIn(min = 52.dp),
                    ) {
                        LineIcon(AppIcon.Forward, null, Modifier.size(20.dp))
                        Spacer(Modifier.width(8.dp))
                        Text(stringResource(R.string.forward_action))
                    }
                }
            }
        }
    }
}
