package com.omnimail.android.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.Dp
import com.omnimail.android.R
import com.omnimail.android.data.model.MailFolder
import com.omnimail.android.data.model.MessageSummary
import com.omnimail.android.ui.components.AppIcon
import com.omnimail.android.ui.components.LineIcon
import com.omnimail.android.ui.components.OmniMailLogo
import kotlinx.coroutines.flow.distinctUntilChanged

@Composable
internal fun MessageList(
    state: AppUiState,
    onSelect: (String) -> Unit,
    onLoadMore: () -> Unit,
    modifier: Modifier = Modifier,
    bottomContentPadding: Dp = 8.dp,
) {
    val navigationBarInset = WindowInsets.navigationBars.asPaddingValues().calculateBottomPadding()
    val listState = rememberLazyListState()
    LaunchedEffect(
        listState,
        state.messages.size,
        state.messagePage.hasMore,
        state.isLoadingMore,
    ) {
        snapshotFlow { listState.layoutInfo.visibleItemsInfo.lastOrNull()?.index }
            .distinctUntilChanged()
            .collect { lastVisible ->
                val loadThreshold = (state.messages.size - 5).coerceAtLeast(0)
                if (
                    lastVisible != null &&
                    lastVisible >= loadThreshold &&
                    state.messagePage.hasMore &&
                    !state.isLoadingMore
                ) {
                    onLoadMore()
                }
        }
    }
    when {
        state.isRefreshing && state.messages.isEmpty() -> MessageListSkeleton(modifier)
        state.messages.isEmpty() -> EmptyPane(
            title = if (state.searchQuery.isBlank()) {
                stringResource(R.string.empty_mail_title)
            } else {
                stringResource(R.string.no_search_results_title)
            },
            detail = if (state.searchQuery.isBlank()) {
                emptyFolderDetail(state.folder)
            } else {
                stringResource(R.string.no_search_results_detail)
            },
            modifier = modifier,
        )
        else -> LazyColumn(
            state = listState,
            modifier = modifier
                .fillMaxSize()
                .background(MaterialTheme.colorScheme.background),
            contentPadding = PaddingValues(
                start = 8.dp,
                top = 4.dp,
                end = 8.dp,
                bottom = navigationBarInset + bottomContentPadding,
            ),
            verticalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            items(state.messages, key = { it.id }) { message ->
                MessageRow(
                    message = message,
                    selected = message.id == state.selectedMessageId,
                    onClick = { onSelect(message.id) },
                )
            }
            if (state.isLoadingMore) {
                item(key = "loading-more") {
                    val loadingLabel = stringResource(R.string.loading_more_mail)
                    Box(
                        Modifier
                            .fillMaxWidth()
                            .padding(16.dp)
                            .semantics { contentDescription = loadingLabel },
                        contentAlignment = Alignment.Center,
                    ) {
                        CircularProgressIndicator(Modifier.size(24.dp), strokeWidth = 2.dp)
                    }
                }
            }
        }
    }
}

@Composable
private fun MessageListSkeleton(modifier: Modifier) {
    val loadingLabel = stringResource(R.string.loading_mail)
    Column(
        modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.background)
            .padding(horizontal = 20.dp, vertical = 12.dp)
            .semantics { contentDescription = loadingLabel },
        verticalArrangement = Arrangement.spacedBy(18.dp),
    ) {
        repeat(8) { index ->
            Row(verticalAlignment = Alignment.CenterVertically) {
                Surface(
                    modifier = Modifier.size(48.dp),
                    shape = CircleShape,
                    color = MaterialTheme.colorScheme.surfaceVariant,
                ) { }
                Spacer(Modifier.width(14.dp))
                Column(
                    Modifier.weight(1f),
                    verticalArrangement = Arrangement.spacedBy(7.dp),
                ) {
                    Surface(
                        modifier = Modifier
                            .width(if (index % 2 == 0) 148.dp else 112.dp)
                            .height(14.dp),
                        shape = RoundedCornerShape(7.dp),
                        color = MaterialTheme.colorScheme.surfaceVariant,
                    ) { }
                    Surface(
                        modifier = Modifier.fillMaxWidth(if (index % 3 == 0) .78f else .62f)
                            .height(12.dp),
                        shape = RoundedCornerShape(6.dp),
                        color = MaterialTheme.colorScheme.surfaceVariant,
                    ) { }
                    Surface(
                        modifier = Modifier.fillMaxWidth(.48f).height(10.dp),
                        shape = RoundedCornerShape(5.dp),
                        color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = .72f),
                    ) { }
                }
            }
        }
    }
}

@Composable
private fun MessageRow(message: MessageSummary, selected: Boolean, onClick: () -> Unit) {
    val linkLabel = stringResource(R.string.link_placeholder)
    val sender = message.senderName.ifBlank {
        message.senderAddress.ifBlank { stringResource(R.string.unknown_sender) }
    }
    val locale = LocalConfiguration.current.locales[0]
    Row(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(18.dp))
            .background(
                if (selected) MaterialTheme.colorScheme.secondaryContainer else Color.Transparent,
            )
            .clickable(role = Role.Button, onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 12.dp),
        verticalAlignment = Alignment.Top,
    ) {
        SenderAvatar(sender, message.isRead)
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    sender,
                    style = MaterialTheme.typography.bodyLarge,
                    fontWeight = if (message.isRead) FontWeight.Normal else FontWeight.Bold,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                Spacer(Modifier.width(8.dp))
                Text(
                    formatMessageDate(message.date, locale),
                    style = MaterialTheme.typography.labelSmall,
                    fontWeight = if (message.isRead) FontWeight.Normal else FontWeight.SemiBold,
                    color = if (message.isRead) {
                        MaterialTheme.colorScheme.onSurfaceVariant
                    } else {
                        MaterialTheme.colorScheme.primary
                    },
                )
            }
            Spacer(Modifier.height(2.dp))
            Text(
                readableMessageText(message.subject, linkLabel)
                    .ifBlank { stringResource(R.string.no_subject) },
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = if (message.isRead) FontWeight.Normal else FontWeight.SemiBold,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Spacer(Modifier.height(2.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    readableMessageText(message.preview, linkLabel),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                if (message.attachmentCount > 0) {
                    Spacer(Modifier.width(6.dp))
                    LineIcon(
                        AppIcon.Attachment,
                        stringResource(R.string.has_attachments),
                        Modifier.size(16.dp),
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                if (message.isStarred) {
                    Spacer(Modifier.width(6.dp))
                    LineIcon(
                        AppIcon.Star,
                        stringResource(R.string.starred_state),
                        Modifier.size(16.dp),
                        color = MaterialTheme.colorScheme.tertiary,
                        filled = true,
                    )
                }
            }
        }
    }
}

@Composable
private fun SenderAvatar(sender: String, isRead: Boolean) {
    val token = (sender.hashCode() and Int.MAX_VALUE) % 3
    val background = if (isRead) {
        MaterialTheme.colorScheme.surfaceVariant
    } else {
        when (token) {
            0 -> MaterialTheme.colorScheme.primaryContainer
            1 -> MaterialTheme.colorScheme.secondaryContainer
            else -> MaterialTheme.colorScheme.tertiaryContainer
        }
    }
    val foreground = if (isRead) {
        MaterialTheme.colorScheme.onSurfaceVariant
    } else {
        when (token) {
            0 -> MaterialTheme.colorScheme.onPrimaryContainer
            1 -> MaterialTheme.colorScheme.onSecondaryContainer
            else -> MaterialTheme.colorScheme.onTertiaryContainer
        }
    }
    Box(
        Modifier.size(40.dp).clip(CircleShape).background(background),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            sender.firstOrNull()?.uppercase() ?: "?",
            style = MaterialTheme.typography.titleSmall,
            fontWeight = FontWeight.SemiBold,
            color = foreground,
        )
    }
}

@Composable
internal fun EmptyPane(title: String, detail: String, modifier: Modifier = Modifier) {
    Box(modifier.fillMaxSize().padding(24.dp), contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            OmniMailLogo(Modifier.size(66.dp))
            Spacer(Modifier.height(18.dp))
            Text(title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
            Spacer(Modifier.height(6.dp))
            Text(
                detail,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                textAlign = TextAlign.Center,
            )
        }
    }
}

@Composable
private fun emptyFolderDetail(folder: MailFolder): String = stringResource(
    when (folder) {
        MailFolder.Inbox -> R.string.empty_mail_detail
        MailFolder.Starred -> R.string.empty_starred_detail
        MailFolder.Sent -> R.string.empty_sent_detail
        MailFolder.Trash -> R.string.empty_trash_detail
    },
)
