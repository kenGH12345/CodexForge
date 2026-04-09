---
name: game-architecture
version: 1.0.0
type: pattern-skill
domains: [game, architecture]
dependencies: []
load_level: on-demand
max_tokens: 800
triggers:
  keywords: [ecs, entity-component-system, game-loop, game-architecture, event-system, object-pooling]
  roles: [developer]
description: "Game architecture patterns: ECS, game loop, and entity systems"
---
# Skill: game-architecture

> **Type**: Pattern Skill
> **Version**: 1.0.0
> **Description**: Game architecture patterns: ECS, game loop, and entity systems
> **Domains**: game, architecture

---

## Rules

1. **Separate data from behavior in ECS** — Components should contain ONLY data ( POD structs), Systems contain ONLY logic (processing components with specific criteria). Never put logic in components or data in systems.

2. **Never use `new`/`delete` for frequently spawned objects** — Game entities (bullets, particles, enemies) created/destroyed every frame cause GC pressure and frame spikes. Always use object pools with pre-allocated capacity.

3. **Keep game loop deterministic and fixed timestep** — Physics and simulation must use fixed delta time to maintain consistency across different frame rates. Separate render loop (variable) from update loop (fixed).

4. **Use event bus with typed channels** — Decouple systems using an event bus, but type your events (don't use string keys). Prevents typos and enables compile-time checking. Clean up subscriptions when listeners are destroyed.

5. **Entities should NEVER directly reference other entities** — Use Entity IDs (handles) instead of pointers to prevent dangling references when entities are destroyed. Query systems by component composition, not by entity reference.

6. **Cache component queries** — Repeatedly querying "all entities with Position and Velocity" is expensive. Cache query results or use archetype-based storage (chunks) for cache-friendly iteration.

## Standard Project Structure

```
game-project/
├── src/
│   ├── core/                       ← Engine foundation
│   │   ├── GameLoop.h/cpp          ← Fixed timestep update
│   │   ├── EventBus.h/cpp          ← Decoupled communication
│   │   └── ObjectPool.h/cpp        ← Generic pool allocator
│   ├── ecs/                        ← Entity Component System
│   │   ├── World.h/cpp             ← ECS world/registry
│   │   ├── Entity.h/cpp            ← Entity (just an ID)
│   │   ├── Component.h             ← Component type definitions
│   │   └── System.h/cpp            ← Base System class
│   ├── components/                 ← Component data structs
│   │   ├── Position.hpp            ← struct { float x, y, z; };
│   │   ├── Velocity.hpp            ← struct { float dx, dy, dz; };
│   │   ├── Health.hpp              ← struct { int current, max; };
│   │   └── Renderable.hpp          ← struct { Mesh* mesh; Material* mat; };
│   ├── systems/                    ← System implementations
│   │   ├── MovementSystem.cpp      ← Updates Position from Velocity
│   │   ├── CollisionSystem.cpp     ← Spatial queries, AABB checks
│   │   ├── HealthSystem.cpp        ← Death handling, damage calc
│   │   └── RenderSystem.cpp        ← Batch rendering, culling
│   ├── events/                     ← Event type definitions
│   │   ├── EntityDestroyed.hpp
│   │   ├── DamageEvent.hpp
│   │   └── CollisionEvent.hpp
│   └── main.cpp
└── assets/                         ← Meshes, textures, audio
```

## SOP (Standard Operating Procedure)

1. **ECS Design Flow**: Identify entity types in your game → Decompose into data components (no logic) → Define systems that process component combinations → Implement query filters for each system → Register systems to execute in dependency order.
2. **Game Loop Implementation**: Fixed update rate (60Hz default) for physics/simulation → Accumulator pattern for handling variable frame rates → Variable render rate for smooth visuals → Separate interpolation for visual smoothing between fixed steps.
3. **Event System Setup**: Define strongly-typed event structs → Create event bus with per-channel (type) queues → Systems emit events instead of direct calls → Listening systems process event queues → Clear queues at end of frame.

## Checklist

- [ ] No raw pointers to entities (use Entity IDs)
- [ ] All frequently-created objects use object pools
- [ ] Game loop uses fixed timestep for updates
- [ ] Systems have no direct dependencies on each other
- [ ] Component data is POD (plain old data), no logic
- [ ] Event subscriptions cleaned up on entity destruction
- [ ] Component queries cached or use archetype-based iteration

## Best Practices

1. **Use SoA (Structure of Arrays) for cache efficiency** — Instead of Array of Structs (AoS), store components in separate arrays per type. When processing MovementSystem, you stream through tightly-packed Position/Velocity arrays without cache misses from unrelated data.

2. **Sparse sets for component storage** — Use sparse array + dense array pattern for component storage. O(1) add/remove, cache-friendly iteration, minimal memory overhead for empty components. Critical for games with 10k+ entities.

3. **System execution ordering with dependencies** — Systems must execute in correct order (Movement before Collision). Define explicit dependencies or use a dependency graph. Prevents subtle frame-order bugs.

4. **Archetypes for query optimization** — Group entities with identical component sets into archetypes (chunks). Query "Position + Velocity" only iterates relevant archetypes, skipping entities that lack matching components entirely.

5. **Command pattern for structural changes** — Creating/destroying entities mid-frame causes iterator invalidation. Queue structural changes (add/remove components, create/destroy entities) and execute at end of frame or start of next.

## Anti-Patterns

1. **God Object / Singleton GameManager** — A single class managing everything with static accessors. Instead: use dependency injection, service locator with interfaces, or pass required systems as constructor parameters.

2. **Deep inheritance hierarchies for game objects** — `Entity -> Character -> Player -> LocalPlayer`. Instead: use composition (ECS). Entities are flat IDs with attached components. Behavior emerges from component combination.

3. **Updating all systems every entity** — Checking "if (entity.HasComponent<AI>())" in every system. Instead: use query filters so systems only iterate entities with relevant components. Cache-friendly and cleaner code.

4. **Synchronous loading during gameplay** — Loading assets or level data on main thread causes hitches. Instead: implement async loading with loading screens, stream assets in background, use placeholder assets while loading.

5. **Using strings for entity tags/types** — `if (entity.tag == "Player")` is brittle and slow. Instead: use component criteria queries ("entities with PlayerController component") or bitmasks for fast filtering.

## Context Hints

1. **ECS libraries by language**: C++ → EnTT (fast, header-only), Flecs (feature-rich); C# → LeoECS, Entitas (Unity-specific); Rust → Bevy ECS, hecs; JavaScript -bitECS. Don't build ECS from scratch unless necessary.

2. **Entity ID recycling** — After destroying entity #100, you may want to reuse that ID. Use version counters with IDs (32-bit index + 32-bit version) to detect stale references.

3. **Parallel system execution** — Systems with no shared write access can execute in parallel. Use job systems (Unity Jobs, enTT meta, custom thread pools) to utilize multiple cores for massive entity counts.

4. **Save/load serialization** — ECS makes save games straightforward: serialize all components. But handle entity ID remapping on load (IDs may differ from save file). Store component type registry for forward compatibility.

5. **Hybrid ECS approach** — You don't need pure ECS. Many games use ECS for gameplay entities but traditional OOP for UI, audio, and global systems. Use the right tool for each subsystem.

## Integration Guide

### When This Skill Activates

| Context | Trigger | Application |
|---------|---------|-------------|
| Design | Designing game entity system | ECS vs OOP architecture decision |
| Implementation | Writing game logic | System design, component definition |
| Optimization | Performance issues | Object pooling, query optimization |

### Related Patterns

- **AI Patterns**: Behavior systems for game entities
- **Unity/C#**: Engine-specific implementations
- **Performance**: Frame time optimization techniques
- **Testing**: Game system testing strategies

## Evolution History

| Version | Date | Change |
|---------|------|--------|
| v1.0.0 | 2026-03-26 | Initial creation with ECS patterns, game loop design, and event systems architecture |
