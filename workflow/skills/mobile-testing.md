---
name: mobile-testing
version: 1.0.0
type: domain-skill
domains: [testing, mobile, qa]
dependencies: [test-report]
load_level: task
max_tokens: 800
triggers:
  keywords: [mobile test, appium, espresso, xcuitest, detox, device testing, ui automation, mobile qa]
  roles: [tester, developer]
description: "Mobile app testing patterns: UI automation, device compatibility, and platform-specific testing strategies"
---
# Skill: mobile-testing

> **Type**: Domain Skill
> **Version**: 1.0.0
> **Description**: Mobile app testing patterns: UI automation, device compatibility, and platform-specific testing strategies
> **Domains**: testing, mobile, qa

---

## Rules

1. **Never hardcode wait times** — Mobile UI operations are asynchronous. Use explicit waits (Espresso: `IdlingResource`, XCUITest: `waitForExistence`, Detox: `waitFor`) instead of `sleep()`. Hardcoded waits make tests slow and flaky.

2. **Test on physical devices before release** — Emulators/simulators miss real-world issues: touch sensitivity, thermal throttling, memory pressure, manufacturer-specific bugs. Run critical tests on at least 3 physical devices with different OS versions.

3. **Always test lifecycle transitions** — Mobile apps are killed, backgrounded, rotated, and interrupted. Test: rotation (data persistence), background/foreground (state restoration), low memory (process death), incoming calls (interruptions).

4. **Use accessibility IDs for element selection** — Text-based selectors (`text("Submit")`) break on localization. Assign unique `accessibilityIdentifier` (iOS) or `contentDescription` (Android) to interactive elements. This also improves accessibility.

5. **Treat flaky tests as high-priority bugs** — A flaky test (sometimes passes, sometimes fails) destroys CI trust. If a test is flaky: quarantine it, root-cause the issue, fix it, then re-enable. Never ignore flakiness.

6. **Network mocking for offline tests** — Don't rely on airplane mode or actual network disconnection. Use mock servers (WireMock, MockWebServer) to simulate timeouts, slow connections (3G), and specific error codes deterministically.

## Mobile Testing Pyramid

```
        ╱╲
       ╱  ╲  E2E (Device/Simulator)
      ╱ 5% ╲  Real device flows on few devices
     ╱────────╲
    ╱          ╲  Integration (API + DB + UI)
   ╱    20%     ╲  Cross-component on simulators
  ╱────────────────╲
 ╱                  ╲  Unit Tests (ViewModels, Logic)
╱       75%          ╲  Fast, deterministic, no framework
─────────────────────
```

**Key Differences from Web Testing**:
- E2E tests are much slower (60-120s per test vs 5s web)
- Device matrix multiplies test count exponentially
- Simulator ≠ Device for some features (camera, push, biometrics)

## SOP (Standard Operating Procedure)

1. **UI Automation Setup**: Choose framework (Espresso for Android, XCUITest for iOS, Detox for cross-platform) → Add framework to build configuration → Create first "sanity" test (launch app → verify home screen visible) → Set up CI runner (GitHub Actions with macOS runner, Bitrise, etc.).
2. **Page Object Pattern Implementation**: Create Page Object for each screen (encapsulates locators and actions) → Page methods return other Pages (fluent interface: `loginPage.enterCredentials().tapLogin() returns HomePage`) → Keep locators in one place for maintenance.
3. **Device Matrix Selection**: Cover minimum and target OS versions (e.g., Android 10 and 14) → Include different screen sizes (phone and tablet) → Representative manufacturers (Google, Samsung, Xiaomi for Android) → Run full matrix weekly, smoke tests on PR.

## Checklist

- [ ] UI tests use accessibility IDs, not text content
- [ ] Tests handle both phone and tablet orientations
- [ ] Offline mode behavior verified (mock network state)
- [ ] Permissions (camera, location, notifications) tested: denied, granted, "ask next time"
- [ ] App lifecycle tested: background/foreground, rotation, low memory
- [ ] Deep links/universal links tested
- [ ] Push notification reception and handling tested
- [ ] Screenshot captured on test failure

## Best Practices

1. **Parallel test execution by sharding** — Mobile tests are slow. Run them in parallel across multiple devices/simulators using test sharding (split test suite by class count). Use CI matrix strategy to run different OS versions concurrently.

2. **Screenshot/video recording on failure** — Mobile failures are hard to debug. Automatically capture screenshot on assertion failure, record video of entire test run. Store as CI artifacts for investigation.

3. **Use product flavors/targets for test variants** — Create `debug` build with test hooks (disable animations, expose test IDs). Never ship test code in production builds. Use build configuration to inject test dependencies.

4. **Test IDs file maintained separately** — Keep a JSON/YAML file mapping logical element names to actual IDs (`loginButton: login_submit_btn`). Use this in tests to avoid hardcoding IDs in test code. Also serves as documentation.

5. **Mock location for location-based tests** — Don't require physical travel or GPS spoofing apps. Use framework location mocking: Espresso has `GrantPermissionRule` + mock location provider, XCUITest can simulate coordinates.

## Anti-Patterns

1. **Testing implementation details** — `expect(button.isEnabled()).toBe(true)` vs `expect(button).toBeVisible()`. Test user-observable behavior, not internal state. Internal refactoring (converting button to custom view) shouldn't break tests.

2. **Monolithic test class** — Single file with 50+ tests covering entire app. Instead: organize by screen/feature, one Page Object per screen, tests grouped by user flow. Makes parallelization easier.

3. **Relying on test data in production database** — Tests assume "User John Doe exists in DB". Instead: use test accounts dedicated to automation, seed data via API before test, or use mocked responses. Don't contaminate production data.

4. **No retry mechanism for flakiness** — Adding retry logic to hide flakiness is treating symptoms. Instead: identify root cause (timing, race condition, missing wait) and fix it. Retries waste CI time and hide real issues.

5. **Different build configurations for CI vs local** — "Works on my machine" syndrome. Instead: use Docker containers or identical CI scripts locally (act for GitHub Actions). Environment differences cause the most debugging pain.

## Context Hints

1. **iOS Simulator limitations**: No camera, no push notifications, no Sign in with Apple (real device needed), no App Store receipt validation, 3D Touch simulation limited. Plan E2E tests accordingly.

2. **Android Fragmentation reality**: Thousands of device models, manufacturer-specific behaviors (Xiaomi aggressive background killing, Samsung battery optimization), different permission dialog styles. Maintain top-10 device list based on analytics.

3. **Test framework comparison**: Espresso (fast, Android-only, direct view access); XCUITest (official, iOS-only, slower but stable); Detox (cross-platform, Gray-box, excellent React Native support, fast); Appium (cross-platform, WebDriver protocol, slower but flexible).

4. **CI cost warning**: Mac runners for iOS are expensive (10x Linux). Strategy: run iOS E2E only on `main` branch merges, Android E2E on every PR. Use caching for dependencies aggressively.

5. **Accessibility as a bonus**: Adding accessibility IDs for testing also enables VoiceOver/TalkBack support. Accessibility trees are often cleaner for test automation than visible text.

## Integration: Using with WorkFlowAgent

### When `mobile-testing` Loads

| Phase | Trigger | Purpose |
|-------|---------|---------|
| TEST | Writing mobile app tests | UI automation guidance |
| TEST | Debugging flaky mobile tests | Root cause analysis |
| OPTIMIZE | CI speed issues | Sharding/parallelization strategy |

### Interaction with Other Skills

```
mobile-testing (this skill)
├── ios-dev (iOS-specific testing hooks)
├── android-dev (Android-specific testing setup)
├── flutter-dev (Flutter widget testing)
├── test-report (general test structure)
└── performance-optimization (mobile performance profiling)
```

## Evolution History

| Version | Date | Change |
|---------|------|--------|
| v1.0.0 | 2026-03-26 | Initial creation with mobile UI automation patterns, device testing strategies, and platform-specific considerations |
