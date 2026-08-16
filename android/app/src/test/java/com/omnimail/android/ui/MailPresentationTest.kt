package com.omnimail.android.ui

import com.omnimail.android.data.model.MailCounts
import com.omnimail.android.data.model.MailFolder
import com.omnimail.android.data.model.MessageSummary
import java.time.Instant
import java.time.ZoneId
import java.util.Locale
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MailPresentationTest {
    @Test
    fun `timestamp supports API milliseconds and legacy seconds`() {
        val expected = Instant.parse("2026-08-11T05:05:00Z")

        assertEquals(expected, timestampInstant(expected.toEpochMilli()))
        assertEquals(expected, timestampInstant(expected.epochSecond))
    }

    @Test
    fun `full message date includes the local GMT offset`() {
        val timestamp = Instant.parse("2026-08-11T05:05:00Z").toEpochMilli()

        val result = formatFullDate(timestamp, Locale.SIMPLIFIED_CHINESE, ZoneId.of("Asia/Singapore"))

        assertTrue(result.contains("2026"))
        assertTrue(result.endsWith("GMT+08:00"))
        assertTrue(formatFullDate(timestamp, Locale.US, ZoneId.of("UTC")).endsWith("GMT+00:00"))
    }

    @Test
    fun `message text hides tracking URLs and decodes entities`() {
        val result = readableMessageText(
            "Hello&amp;#8202; [https://tracker.example/r?id=1] &#x1F680; &amp; welcome",
        )

        assertEquals("Hello\u200A [link] 🚀 & welcome", result)
        assertFalse(result.contains("tracker.example"))
        assertEquals("link", readableMessageText("[https://tracker.example/open"))
    }

    @Test
    fun `detects dark email backgrounds for gesture contrast`() {
        assertTrue(emailUsesDarkBackground("<body style='background:#121212'>"))
        assertTrue(emailUsesDarkBackground("<table bgcolor=\"#000\">"))
        assertFalse(emailUsesDarkBackground("<body style='background-color:#f8f8f8'>"))
    }

    @Test
    fun `escapes app generated message metadata`() {
        assertEquals("&lt;script&gt;&amp;&quot;&#39;", htmlEscape("<script>&\"'"))
    }

    @Test
    fun `folder counts and summary use server totals`() {
        val state = AppUiState(
            folder = MailFolder.Inbox,
            counts = MailCounts(unread = 4, starred = 2, sent = 21, trash = 11),
            messages = listOf(MessageSummary(id = "one"), MessageSummary(id = "two")),
        )

        assertEquals(4, state.folderCount(MailFolder.Inbox))
        assertEquals(21, state.folderCount(MailFolder.Sent))
        assertEquals(
            "2 messages loaded · 4 unread",
            state.folderSummary("2 messages loaded", "4 unread"),
        )
    }
}
