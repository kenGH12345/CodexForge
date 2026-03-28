---
name: ios-dev
version: 1.0.0
type: domain-skill
domains: [ios, mobile, swift]
dependencies: []
load_level: task
max_tokens: 800
triggers:
  keywords: [swift, swiftui, uikit, combine, coredata, xcode, ios]
  roles: [developer]
description: "iOS/Swift native development patterns and best practices"
---
# Skill: ios-dev

> **Type**: Domain Skill
> **Version**: 1.0.0
> **Description**: iOS/Swift native development patterns and best practices
> **Domains**: ios, mobile, swift

---

## Rules

1. **Always use `let` over `var` when immutability is possible** — Immutable code is safer, thread-friendly, and enables compiler optimizations. Declare variables as `let` by default, only use `var` when mutation is actually needed.

2. **Prefer `guard` over `if` for early returns** — Use `guard let` or `guard condition else { return/handle }` at function entry points. It reduces nesting, makes happy-path logic more prominent, and enforces early exit on error conditions.

3. **Never force-unwrap (`!`) without a documented fallback** — Force-unwrapping causes runtime crashes. Use `if let`, `guard let`, or provide explicit default values with `??`. Document any force-unwrap that is truly unavoidable.

4. **Use `@MainActor` for UI-related code** — Swift Concurrency requires explicit main-thread isolation for UI updates. Mark view controllers, SwiftUI views, and UI-manipulating classes with `@MainActor` to prevent data races.

5. **Prefer `async/await` over callback-based completion handlers** — Modern Swift uses structured concurrency. Convert legacy callback APIs to async using `withCheckedThrowingContinuation`. It's more readable, composable, and handles cancellation automatically.

6. **Always cancel Combine subscriptions in `deinit` or `onDisappear`** — Retained publishers cause memory leaks. Store `AnyCancellable` in a `Set` and call `.cancel()` or let the set be deallocated with the view/controller.

## Standard Project Structure

```
project-root/
├── ProjectName/
│   ├── App/
│   │   ├── App.swift                    ← @main entry point
│   │   └── AppDelegate.swift            ← (Optional) Lifecycle hooks
│   ├── Features/
│   │   ├── FeatureA/
│   │   │   ├── Models/
│   │   │   ├── Views/
│   │   │   ├── ViewModels/
│   │   │   └── Services/
│   │   └── FeatureB/
│   ├── Core/
│   │   ├── Networking/
│   │   ├── Persistence/
│   │   └── Utilities/
│   ├── Resources/
│   │   ├── Assets.xcassets
│   │   └── Localizable.strings
│   └── Preview Content/
├── ProjectNameTests/
├── ProjectNameUITests/
└── ProjectName.xcodeproj
```

## SOP (Standard Operating Procedure)

1. **Architecture Selection**: SwiftUI project → MVVM with `@Observable` (iOS 17+) or `@StateObject` (iOS 16-); UIKit project → MVVM with Combine or Delegate patterns; Complex shared state → TCA (The Composable Architecture) or clean architecture with coordinators.
2. **State Management Flow**: Local view state → `@State` or `@StateObject`; Shared feature state → `@Observable` class or Store pattern; Server-synced state → Repository pattern with Combine publishers or async sequences.
3. **Navigation Implementation**: SwiftUI → NavigationStack with path-based routing (iOS 16+); Deep linking → Handle in `onOpenURL` or `scene(_:openURLContexts:)`; Programmatic navigation → Use `NavigationPath` for complex flows.

## Checklist

- [ ] No force-unwrap (`!`) operators without documented justification
- [ ] All Combine subscriptions properly cancelled
- [ ] `@MainActor` applied to UI-related classes and methods
- [ ] SwiftLint or similar linter integrated and passing
- [ ] Asset catalog uses proper @2x/@3x scales
- [ ] Localizable strings externalized for all user-facing text
- [ ] Background tasks use `Task` with proper cancellation handling

## Best Practices

1. **Use `@Observable` for reactive state (iOS 17+)** — The new `@Observable` macro replaces `@Published` and eliminates the need for `ObservableObject`. It's more performant and doesn't require `objectWillChange` boilerplate.

2. **Leverage SwiftUI ViewModifiers for reusable styling** — Instead of copying styling code across views, create custom `ViewModifier` types. This encapsulates visual design and makes UI consistency easier to maintain.

3. **Use `Result` type for completion handlers** — When async/await isn't possible, use `Result<Success, Error>` instead of separate success/failure closures. It's type-safe, composable, and forces error handling.

4. **Prefer ` structs` over ` classes` for models** — Value types are safer, thread-safe by default, and have predictable copy-on-write behavior. Use classes only for identity-based entities or when reference semantics are truly needed.

5. **Use Swift Package Manager for dependencies** — SPM is the modern, first-party package manager. Prefer it over CocoaPods or Carthage for new projects. Pin versions explicitly to ensure reproducible builds.

## Anti-Patterns

1. **Massive View Controller** — Putting all logic in a UIViewController with 500+ lines. Instead: use MVVM to extract business logic, create separate coordinator classes for navigation flow, and decompose into custom views.

2. **Callback hell with nested closures** — Deeply nested completion handlers that are hard to read and error-prone. Instead: convert to async/await, use Combine operators like `.flatMap`, or use Promise/Future abstractions.

3. **Using `DispatchQueue.main.async` everywhere** — Randomly dispatching to main queue without understanding why. Instead: use `@MainActor` annotation, `MainActor.run`, or Combine's `.receive(on: DispatchQueue.main)` for explicit thread control.

4. **Ignoring memory warnings** — Not implementing `didReceiveMemoryWarning()` or letting image caches grow unbounded. Instead: respond to `UIApplication.didReceiveMemoryWarningNotification`, implement LRU eviction for custom caches, and use `NSCache` instead of dictionaries for image/data caching.

5. **Synchronous Core Data on main thread** — Performing heavy Core Data operations in main context, blocking UI. Instead: use background `NSManagedObjectContext` with `perform`, implement NSFetchedResultsController for efficient list updates, or migrate to SwiftData for simpler async patterns.

## Context Hints

1. **SwiftUI View lifecycle** — `onAppear` fires every time the view appears, `task` is for async work and auto-cancels on disappear, `onChange` observes value changes. Don't confuse them — use the right lifecycle hook.

2. **Xcode Previews limitations** — Previews don't run in full app environment. Some APIs (location, camera, certain entitlements) won't work. Test these on actual device/simulator, not just previews.

3. **iOS version adoption curve** — iOS users upgrade quickly (~90% within 6 months of new release). It's usually safe to target `n-1` iOS version for new features, but consult analytics if supporting enterprise users.

4. **App Store review guidelines** — Certain behaviors trigger rejection: not handling background audio correctly, missing privacy descriptions in Info.plist, using non-public APIs, or making apps that are just web views. Review the guidelines before submission.

5. **Simulator vs Device differences** — Performance characteristics differ significantly. Metal shaders, haptic feedback, camera, and push notifications only work on device. Always do final testing on physical hardware.

## Evolution History

| Version | Date | Change |
|---------|------|--------|
| v1.0.0 | 2026-03-26 | Initial creation with Swift/SwiftUI patterns, MVVM architecture, and Combine best practices |
