---
name: WePop_trunk-domain
description: Domain-specific skill for WePop mobile racing game (Unity 2020.3, C#). Covers state-machine architecture, int-key event bus, XLua integration, custom GC-friendly collections, and System module development patterns.
version: 1.0.0
author: WorkFlowAgent
tags: [unity, csharp, xlua, racing-game, state-machine]
llmPowered: true
discoveryMethod: llm-code-analysis
projectPath: D:/WePop_trunk
generatedAt: 2026-04-27
---

# WePop_trunk Domain Skill

> Unity 2020.3.48f1c1 mobile racing game. ~9000 files, 60+ top-level script modules. Heavily XLua-scripted with C# framework layer.

## Project Overview

| Attribute | Value |
|-----------|-------|
| Engine | Unity 2020.3.48f1c1 |
| Language | C# 7.3 + Lua (XLua/tolua) |
| Platform | Mobile (iOS/Android) |
| Scale | 8952 files, 60+ top-level script folders |
| Architecture | State-machine driven singleton GameRoot + modular Systems |

## Critical Architecture Patterns

### 1. State Machine (GameRoot + EStateType)

GameRoot is a MonoBehaviour singleton that owns the entire game lifecycle through `EStateType` enumeration (80+ states: Logo, Loading, MainPage, AvatarAIDispatchMain, ...).

State switching is the SINGLE entry point for all major context changes.

Key conventions:
- `SwitchToStateIndirectChange` performs AI dispatch rerouting
- `OnPreStateChange`, `OnStateChange`, `OnPostStateChange` are XLua bridge events
- `QuitCurrentSwitch` aborts an in-progress transition (fatal error paths)
- Systems receive Enter() and Leave() calls during transitions

### 2. Event Bus (EventMgr) — NOT C# event

The project uses a custom int-key event bus, NOT standard C# event delegates.

EventId is an int, key into SimpleDict<int, SimpleList<CEventData>>.

Key conventions:
- SimpleDict<int, SimpleList<CEventData>> stores listeners by priority
- Supports one-shot listeners and priority ordering
- Event IDs are typically hardcoded ints or defined in const fields
- This design avoids delegate allocation overhead and enables priority queuing

### 3. System Module Lifecycle

All gameplay systems derive from GameSystemBase (or implement IGameSys, which is an empty marker interface).

Lifecycle methods: Enter(), Leave(), Update(), FixedUpdate(), LateUpdate() — called by GameRoot during state transitions and frame updates.

Systems register themselves with GameRoot during initialization: GameRoot.RegisterSystem(typeof(MySystem)).

### 4. XLua Integration Patterns

XLua bridges C# and Lua extensively.

- GameRoot events are Lua-callable
- LuaGameSystem is a special System type routed to Lua
- Configuration and UI flows are often Lua-driven
- C# hot-reload is NOT used; Lua hot-reload is the primary iteration mechanism

### 5. Custom Collections (GC Optimization)

Extensive use of custom collection types to minimize garbage collection:

Rule of thumb: When you see standard C# collections in new code, question whether a SIMPLE variant should be used instead. The project targets mobile GC constraints.

## Coding Conventions

| Pattern | Convention |
|---------|------------|
| Private fields | mCamelCase |
| Public properties | PascalCase |
| Constants | cPascalCase |
| Static/instance | PascalCase for public static |
| Events | On + past participle |

Access Modifiers:
- Framework classes: prefer internal or public
- System classes: public if referenced by Lua or other assemblies
- Private helper methods: keep private; avoid protected unless overriding

File Layout: Framework/, Core/, Systems/, UICtrl/, ArtCode/, <FeatureModule>/

## Anti-Patterns (AVOID)

- Using += / -= on C# events directly — bypasses priority ordering; use EventMgr.Listen/Unlisten instead
- Instantiating Dictionary/List in hot paths — GC pressure; use SimpleDict/SimpleList from ObjectPool
- Calling new StringBuilder() frequently — use SimpleStringBuilder.Concat or pooled builders
- State logic outside GameRoot.SwitchToState — route ALL state changes through SwitchToStateIndirectChange
- Direct Unity FindObjectOfType in Systems — use GameSystemBase registration or constructor injection
- Heavy logic in Update() without frame budgeting — budget work across frames

## System Development Guide

How to Add a New System:
1. Create class under Assets/Scripts/Systems/ (or appropriate feature folder)
2. Inherit from GameSystemBase
3. Override lifecycle methods as needed
4. Register in GameRoot initialization sequence
5. Use EventMgr.Dispatch(eventId, data) for publishing events
6. Use EventMgr.Listen(eventId, callback, priority) for subscribing
7. Ensure Leave() unsubscribes from events and releases pooled resources

State-Aware Behavior: GameRoot.CurState is set to the NEW state BEFORE Enter() is called, so you can determine which state you are entering.

## Key Dependencies

XLua/tolua — Lua scripting bridge
LightProfiler — Performance profiling
SIMPLE collections — GC-optimized custom containers

## Debugging & Profiling

- Use #define PROFILE to enable LightProfiler instrumentation
- Use #define SHOW_FPS for runtime FPS display
- Use GameSystemBase.LogInfo() for consistent logging
- Hook OnPreStateChange / OnStateChange / OnPostStateChange for state transition debugging
