---
name: android-dev
version: 1.0.0
type: domain-skill
domains: [android, mobile, kotlin]
dependencies: []
load_level: task
max_tokens: 800
triggers:
  keywords: [kotlin, jetpack-compose, android, coroutines, flow, room, viewmodel]
  roles: [developer]
description: "Android/Kotlin native development with Jetpack Compose patterns"
---
# Skill: android-dev

> **Type**: Domain Skill
> **Version**: 1.0.0
> **Description**: Android/Kotlin native development with Jetpack Compose patterns
> **Domains**: android, mobile, kotlin

---

## Rules

1. **Never block the main thread** — UI thread must never perform I/O, heavy computation, or synchronous database queries. Always use `suspend` functions with `Dispatchers.IO`, `viewModelScope`, or `lifecycleScope`.

2. **Use `rememberSaveable` for configuration changes** — Plain `remember` doesn't survive configuration changes (rotation, dark mode toggle). Use `rememberSaveable` for UI state that must persist across recomposition and config changes.

3. **Always collect Flows with `collectAsStateWithLifecycle()`** — In Compose, use the lifecycle-aware collector (from `androidx.lifecycle:lifecycle-runtime-compose`) instead of plain `collectAsState()`. It automatically pauses collection when the UI is not visible.

4. **Prefer `StateFlow` over `LiveData` for new code** — `StateFlow` is the modern replacement for `LiveData`. It integrates better with coroutines, doesn't require lifecycle owners, and has built-in support for data transformations.

5. **Use `derivedStateOf` for expensive calculations** — When computing derived state from other states in Compose, wrap it in `derivedStateOf { }`. This prevents unnecessary recompositions when the result hasn't actually changed.

6. **Always handle process death gracefully** — Android can kill your app process at any time. Save critical UI state using `rememberSaveable` or `SavedStateHandle`, and restore ViewModel state in `init`.

## Standard Project Structure

```
project-root/
├── app/
│   ├── src/
│   │   ├── main/
│   │   │   ├── java/com/package/
│   │   │   │   ├── MainActivity.kt
│   │   │   │   ├── App.kt                    ← Application class
│   │   │   │   ├── ui/
│   │   │   │   │   ├── theme/                ← MaterialTheme, ColorScheme
│   │   │   │   │   ├── components/           ← Reusable composables
│   │   │   │   │   └── screens/              ← Screen-level UIs
│   │   │   │   ├── data/
│   │   │   │   │   ├── model/                ← Data classes
│   │   │   │   │   ├── repository/           ← Repository pattern
│   │   │   │   │   └── local/                ← Room DAOs
│   │   │   │   ├── viewmodel/                ← ViewModels
│   │   │   │   └── di/                       ← Hilt modules
│   │   │   ├── res/                          ← XML resources
│   │   │   └── AndroidManifest.xml
│   │   └── test/
│   └── build.gradle.kts
├── build.gradle.kts
└── settings.gradle.kts
```

## SOP (Standard Operating Procedure)

1. **Screen Implementation Flow**: Define UI state data class with all necessary fields → Create ViewModel exposing `StateFlow<UiState>` → Implement composable screen observing state → Handle events via ViewModel methods → Add LaunchedEffect for one-time actions (navigation, toasts).
2. **Repository Pattern**: Interface defines contract → Repository implementation coordinates data sources → Remote data source (Retrofit/Ktor) for network → Local data source (Room) for caching → Repository exposes Flow for reactive updates.
3. **Navigation Setup**: Use Jetpack Navigation Compose → Define routes as sealed class or string constants → Pass minimal data in navigation (IDs, not objects) → Handle deep links via `NavController` → Use `BottomSheetNavigator` for modal flows.

## Checklist

- [ ] No `Dispatchers.Main` used for I/O operations
- [ ] All `StateFlow`/`Flow` collections use lifecycle-aware collector
- [ ] `rememberSaveable` used for configuration-critical state
- [ ] Deep links properly validated and handled
- [ ] ProGuard/R8 rules configured for release builds
- [ ] Dark mode supported with proper theme attributes
- [ ] Accessibility labels added to interactive elements

## Best Practices

1. **Use `ImmutableList` from kotlinx.collections.immutable** — Compose's stability system works best with immutable collections. `List<T>` is not considered stable if `T` is not known to be immutable. Use immutable collections for state properties.

2. **Leverage `CompositionLocal` sparingly** — `CompositionLocal` is useful for theme data and navigation, but overuse makes code hard to trace. Prefer explicit parameter passing for most dependencies; reserve CompositionLocal for truly ambient data.

3. **Use `SnapshotStateList<T>` for mutable collections in state** — When holding collections that change (e.g., items in a list), use `mutableStateListOf<T>()` or `SnapshotStateList`. It provides granular change notifications without full object replacement.

4. **Implement proper edge-to-edge handling** — Modern Android apps handle system bars via `WindowInsets`. Use `Modifier.windowInsetsPadding()` and handle IME (keyboard) insets properly. Don't hardcode padding values.

5. **Use `LazyColumn`/`LazyRow` instead of `Column`/`Row` for large lists** — `Column` renders all children immediately. `LazyColumn` uses view recycling and only composes visible items. Essential for lists over ~20 items.

## Anti-Patterns

1. **God ViewModel** — A single ViewModel handling 5+ different screen states. Instead: split into feature-specific ViewModels, use shared ViewModels scoped to navigation graph for cross-screen state.

2. **Passing large objects through navigation** — Passing Parcelable objects or complex JSON via navigation arguments. Instead: pass only IDs, load data in target ViewModel. Navigation arguments have size limits (~500KB).

3. **Mixing presentation logic in Composables** — Composables with business logic, API calls, or complex calculations. Instead: keep composables presentation-only, move logic to ViewModel or use case classes.

4. **Creating new `ViewModel` instances manually** — Using `ViewModelProvider.Factory` or `viewModel()` without Hilt in complex apps. Instead: use Hilt dependency injection for ViewModels and their dependencies.

5. **Ignoring recompositions** — Not using `remember`, `derivedStateOf`, or stable types, causing unnecessary UI redraws. Instead: profile with Layout Inspector, use `@Stable` annotation on custom classes, and leverage `remember` appropriately.

## Context Hints

1. **Compose compiler metrics** — Enable the Compose compiler metrics (`composeCompilerMetrics=true`) to see skipped recompositions. Look for "restartable but not skippable" composables — these are likely missing stability.

2. **Accompanist library** — Google's Accompanist provides useful Compose utilities (permissions, paging, navigation animation) not yet in the main Compose library. Use for advanced features but watch for migration to stable APIs.

3. **Android Studio Compose Preview** — Use `@Preview` composables for rapid UI iteration. They support different configurations (dark mode, font scale, device sizes). Much faster than full app rebuild.

4. **Gradle configuration cache** — Enable `org.gradle.configuration-cache=true` for faster incremental builds. Essential for large Android projects. Some older plugins may be incompatible — update or exclude them.

5. **Play Store requirements** — Target SDK must be within 2 years of latest. 64-bit native libraries required since Aug 2019. Privacy policy required if collecting any user data. Review Play Console policies before release.

## Evolution History

| Version | Date | Change |
|---------|------|--------|
| v1.0.0 | 2026-03-26 | Initial creation with Jetpack Compose, Kotlin Coroutines, and modern Android architecture patterns |
