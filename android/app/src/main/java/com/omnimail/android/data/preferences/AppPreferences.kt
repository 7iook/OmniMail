package com.omnimail.android.data.preferences

import android.content.Context
import android.content.res.Configuration
import android.os.Build
import android.os.LocaleList
import androidx.core.content.edit
import java.util.Locale
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

enum class ThemePreference { System, Light, Dark }
enum class AppLanguage(val languageTag: String) {
    System(""),
    SimplifiedChinese("zh-CN"),
    English("en"),
    ;

    companion object {
        fun fromLanguageTags(tags: String): AppLanguage = when {
            tags.startsWith("zh", ignoreCase = true) -> SimplifiedChinese
            tags.startsWith("en", ignoreCase = true) -> English
            else -> System
        }
    }
}

data class ReaderPreferences(
    val loadRemoteImages: Boolean = false,
    val confirmExternalLinks: Boolean = true,
    val theme: ThemePreference = ThemePreference.System,
    val language: AppLanguage = AppLanguage.System,
)

interface AppPreferences {
    val readerPreferences: StateFlow<ReaderPreferences>
    fun setLoadRemoteImages(enabled: Boolean)
    fun setConfirmExternalLinks(enabled: Boolean)
    fun setTheme(theme: ThemePreference)
    fun setLanguage(language: AppLanguage)
}

class SharedAppPreferences(context: Context) : AppPreferences {
    private val preferences = context.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)
    private val _readerPreferences = MutableStateFlow(
        ReaderPreferences(
            loadRemoteImages = preferences.getBoolean(KEY_REMOTE_IMAGES, false),
            confirmExternalLinks = preferences.getBoolean(KEY_CONFIRM_LINKS, true),
            theme = runCatching {
                ThemePreference.valueOf(
                    preferences.getString(KEY_THEME, ThemePreference.System.name)
                        ?: ThemePreference.System.name,
                )
            }.getOrDefault(ThemePreference.System),
            language = currentAppLanguage(context, preferences.getString(KEY_LANGUAGE, null)),
        ),
    )
    override val readerPreferences: StateFlow<ReaderPreferences> = _readerPreferences.asStateFlow()

    override fun setLoadRemoteImages(enabled: Boolean) = update(
        _readerPreferences.value.copy(loadRemoteImages = enabled),
    )

    override fun setConfirmExternalLinks(enabled: Boolean) = update(
        _readerPreferences.value.copy(confirmExternalLinks = enabled),
    )

    override fun setTheme(theme: ThemePreference) = update(
        _readerPreferences.value.copy(theme = theme),
    )

    override fun setLanguage(language: AppLanguage) = update(
        _readerPreferences.value.copy(language = language),
    )

    private fun update(value: ReaderPreferences) {
        preferences.edit {
            putBoolean(KEY_REMOTE_IMAGES, value.loadRemoteImages)
            putBoolean(KEY_CONFIRM_LINKS, value.confirmExternalLinks)
            putString(KEY_THEME, value.theme.name)
            putString(KEY_LANGUAGE, value.language.name)
        }
        _readerPreferences.value = value
    }

    companion object {
        const val PREFERENCES_NAME = "omnimail_app_preferences"
        const val KEY_REMOTE_IMAGES = "load_remote_images"
        const val KEY_CONFIRM_LINKS = "confirm_external_links"
        const val KEY_THEME = "theme"
        const val KEY_LANGUAGE = "language"
    }
}

fun localizedContext(context: Context): Context {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) return context
    val preferences = context.getSharedPreferences(
        SharedAppPreferences.PREFERENCES_NAME,
        Context.MODE_PRIVATE,
    )
    val language = runCatching {
        AppLanguage.valueOf(
            preferences.getString(
                SharedAppPreferences.KEY_LANGUAGE,
                AppLanguage.System.name,
            ) ?: AppLanguage.System.name,
        )
    }.getOrDefault(AppLanguage.System)
    if (language == AppLanguage.System) return context
    val configuration = Configuration(context.resources.configuration).apply {
        setLocale(Locale.forLanguageTag(language.languageTag))
    }
    return context.createConfigurationContext(configuration)
}

private fun currentAppLanguage(context: Context, storedValue: String?): AppLanguage {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        val tags = context.getSystemService(android.app.LocaleManager::class.java)
            .applicationLocales
            .toLanguageTags()
        return AppLanguage.fromLanguageTags(tags)
    }
    return runCatching {
        AppLanguage.valueOf(storedValue ?: AppLanguage.System.name)
    }.getOrDefault(AppLanguage.System)
}

fun applyAppLanguage(context: Context, language: AppLanguage) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        context.getSystemService(android.app.LocaleManager::class.java).applicationLocales =
            LocaleList.forLanguageTags(language.languageTag)
    } else {
        generateSequence(context) { current ->
            (current as? android.content.ContextWrapper)?.baseContext
                ?.takeUnless { it === current }
        }.filterIsInstance<android.app.Activity>().firstOrNull()?.recreate()
    }
}
