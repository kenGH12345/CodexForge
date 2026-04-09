---
name: game-testing
version: 1.0.0
type: domain-skill
domains: [testing, game, qa]
dependencies: [test-report]
load_level: task
max_tokens: 800
triggers:
  keywords: [game test, frame rate testing, physics test, ai test, game qa, unity test, automated game testing]
  roles: [tester, developer]
description: "Game testing patterns: frame rate validation, physics consistency, AI behavior verification, and deterministic testing"
---
# Skill: game-testing

> **Type**: Domain Skill
> **Version**: 1.0.0
> **Description**: Game testing patterns: frame rate validation, physics consistency, AI behavior verification, and deterministic testing
> **Domains**: testing, game, qa

---

## Rules

1. **Randomness must be deterministic in tests** — Game systems use randomness (loot drops, enemy AI decisions, card draws). In tests, seed the RNG with a fixed value. Tests must pass 100% of the time with same seed. Non-determinism makes tests flaky.

2. **Frame rate tests require statistical rigor** — Don't assert "FPS > 60". Record FPS samples over representative gameplay duration (30s min), assert on percentiles (p95 > 60, p1 > 30). Single-frame spikes are acceptable if brief.

3. **Physics tests must compare state, not visual output** — Screenshot comparison breaks on minor shader changes. Assert on: object positions, velocities, collision counts, health values. Physics should be deterministic given same inputs.

4. **AI behavior requires scenario-based validation** — "Test AI" is too vague. Create specific BDD scenarios: "Given enemy health < 30%, When line-of-sight lost, Then enemy enters search state for max 10s". Test each scenario with mocked world state.

5. **Multiplayer sync requires reconciliation testing** — Test that all clients eventually agree on world state after network jitter/packet loss. Simulate 200ms latency, 2% packet loss in test environment. Assert state consistency across simulated clients.

6. **Memory leak detection is mandatory for long sessions** — Games run for hours. Every test that allocates resources must have corresponding cleanup verification. Use allocation tracking to detect leaking GameObjects, textures, or audio clips.

## Game Testing Layers

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  PLAYTESTS (Human Evaluation)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
└─ Fun factor, balance, difficulty curve
   └─ Automated bots can't assess "fun"

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  INTEGRATION (Systems + Content)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
└─ Level loading, save/load cycle
└─ Power combo interactions
└─ Quest progression validation

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  SYSTEM (ECS/Component Logic)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
└─ Movement system (given velocity, expect position)
└─ Combat system (damage calculation)
└─ Inventory system (add/remove/constraint checks)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  UNIT (Pure Functions, No Engine)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
└─ Math utilities (intersection, pathfinding)
└─ Damage formula functions
└─ Serialization/deserialization
```

## SOP (Standard Operating Procedure)

1. **Performance Test Setup**: Identify critical scenarios (max enemies on screen, particle-heavy spell) → Record FPS over 60s representative gameplay → Assert on p95 frame time (target: 16.6ms = 60FPS) → Run on minimum spec hardware, not just dev machine.
2. **AI Behavior Verification**: Define concrete scenarios for each AI state → Mock world state (health, distance, line-of-sight) → Execute AI update tick → Assert on resulting state/outputs → Test edge cases (0 health, exactly at threshold distance).
3. **Determinism Validation**: Initialize game with fixed seed → Record state snapshots at defined intervals → Re-run with same seed → Compare snapshots bitwise-identical → Fail if any divergence indicates non-determinism bug.

## Checklist

- [ ] RNG is seeded and deterministic across test runs
- [ ] Frame rate assertions use percentiles, not single samples
- [ ] Physics tests assert on numeric state, not screenshots
- [ ] All AI states have scenario-based test coverage
- [ ] Multiplayer state reconciliation tested with simulated latency
- [ ] Memory profiling shows no leaks after 1000 level loads
- [ ] Save/load cycle produces identical game state
- [ ] Stress tests simulate worst-case scenarios (max entities)

## Best Practices

1. **Bot players for regression testing** — Implement autonomous AI players that play the game automatically. Record "golden" runthroughs (human playthroughs). Detect when bot behavior diverges from expected (new obstacles, changed controls).

2. **Checksum-based state validation** — For determinism tests, compute state checksum after each frame. Log checksums during normal gameplay for replay debugging. When bug is reported with checksum, replay to that exact frame.

3. **Heatmap for test coverage analysis** — Track which areas of game world are visited by tests. Visualize as heatmap overlay. Identify untested areas (no coverage on level 3 boss, rarely-used inventory interaction).

4. **Visual diffing for UI, not gameplay** — Use screenshot comparison for static UI (menus, load screens) where pixel-perfect consistency is expected. Never use screenshot comparison for dynamic gameplay (shadows, particles vary).

5. **Parameterized load tests** — Instead of one "heavy" test, parameterize entity count: `test_performance(enemy_count=[10, 50, 100, 200])`. Plot performance curve, identify where it breaks (O(n²) detection).

## Anti-Patterns

1. **Testing rendered output as truth** — Comparing screenshots of gameplay scene. Slight shader changes, particle RNG, or LOD differences cause failures. Instead: assert on underlying game state (object transforms, health values).

2. **Ignoring floating-point determinism** — Physics engines use SIMD optimizations that differ across CPUs. `x86 != ARM` for bitwise float results. Instead: use epsilon comparisons, or run physics with fixed-point or deterministic mode for tests.

3. **Testing with editor-only features** — Tests that only work in Unity Editor mode (like `EditorApplication.isPlaying`). Tests must run in player builds. Use conditional compilation to exclude editor-only code from runtime tests.

4. **Oversimplified test levels** — Creating special "test levels" that don't represent real game scenarios. Instead: record and replay real player sessions, or parameterize existing levels. Test scenarios must match production.

5. **Late integration of testing** — Trying to add tests to completed game. Instead: write tests alongside feature implementation (TDD). Retrofitting tests to 100k LOC codebase is exponentially harder.

## Context Hints

1. **Unity Test Framework**: Uses NUnit. Edit Mode tests (no scene, fast) for pure logic. Play Mode tests (in running scene) for integration. Use `[UnityTest]` attribute for coroutine-based async tests. Test runner available in Editor and CI.

2. **Unreal Automation System**: Uses C++ test classes with `IMPLEMENT_SIMPLE_AUTOMATION_TEST`. Supports latent commands (async). Gauntlet automation framework for large-scale testing. Built-in performance profiling in test runner.

3. **Frame time vs FPS**: FPS is non-linear (16ms = 60FPS, 33ms = 30FPS). Better to assert on frame time in milliseconds. Target: p99 frame time < 33ms (30 FPS minimum spec), p50 < 16.6ms (60 FPS target).

4. **Deterministic replay systems**: Many fighting games (Street Fighter) have replay validation. Same inputs → same results. This doubles as determinism test and bug reproduction tool. Consider implementing for competitive multiplayer games.

5. **Monkey testing**: Random input generation (AIUI monkey runner, Unity Monkey Test). Can find crash bugs but not logic errors. Run overnight CI. Any crash is a bug, regardless of how weird the input sequence is.

## Integration Guide

### When This Skill Activates

| Context | Trigger | Application |
|---------|---------|-------------|
| Testing | Writing game logic tests | Deterministic testing patterns |
| Testing | Frame rate validation | Performance testing standards |
| Testing | AI behavior validation | Scenario-based testing approach |
| Optimization | Memory leak investigation | Long-session testing patterns |

### Related Patterns

- **Game Architecture**: ECS testing patterns
- **AI Patterns**: Behavior tree testing strategies
- **Unity/C#**: Engine-specific test frameworks
- **Reporting**: Test structure and documentation
- **Performance**: Profiling integration techniques

## Evolution History

| Version | Date | Change |
|---------|------|--------|
| v1.0.0 | 2026-03-26 | Initial creation with game-specific testing patterns: determinism, frame rate validation, AI behavior verification, and multiplayer sync testing |
