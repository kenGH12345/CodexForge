---
name: game-ai-patterns
version: 1.0.0
type: pattern-skill
domains: [game, ai]
dependencies: []
load_level: on-demand
max_tokens: 800
triggers:
  keywords: [behavior-tree, state-machine, pathfinding, a-star, navmesh, game-ai, npc-behavior]
  roles: [developer]
description: "Game AI design patterns: behavior trees, state machines, and pathfinding"
---
# Skill: game-ai-patterns

> **Type**: Pattern Skill
> **Version**: 1.0.0
> **Description**: Game AI design patterns: behavior trees, state machines, and pathfinding
> **Domains**: game, ai

---

## Rules

1. **Behavior trees should return explicit status** — Every node must return Success, Failure, or Running. Never return void or ambiguous states. Parent nodes use these statuses to make flow control decisions.

2. **Never couple AI to specific entities** — AI logic should work with interfaces/abstracts (IActor, IMovement). The same behavior tree should work on player companions, NPCs, or enemies without modification.

3. **Pathfinding queries must be interruptible** — Long path calculations can freeze the frame. Use async/coroutine pathfinding, time-sliced computation, or query caching. Always allow cancellation if target becomes invalid.

4. **State machines must handle ALL transitions** — Every state should explicitly define what happens for every possible input/event. Don't leave "default" cases that do nothing — undefined behavior causes bugs.

5. **Separate decision-making from execution** — The AI brain decides WHAT to do, a separate system handles HOW to do it (move, play animation). Prevents blocking the AI while actions play out.

6. **Limit perception update frequency** — AI doesn't need perfect information every frame. Use update tick rates (e.g., perception checks every 0.2s, path recalculation every 0.5s) to save CPU.

## AI Architecture Patterns

### Behavior Tree Structure

```
Behavior Tree (Root)
├── Selector (OR) - Try children until one succeeds
│   ├── Sequence (AND) - All must succeed in order
│   │   ├── Condition: Has valid target?
│   │   ├── Action: Move to target
│   │   └── Action: Attack target
│   └── Sequence
│       ├── Condition: Health < 30%?
│       └── Action: Find cover
├── Parallel - Run all children simultaneously
│   ├── Action: Move along path
│   └── Action: Scan for threats
└── Decorator: Repeat Until Failure
    └── Action: Patrol waypoint
```

**Node Types**:
- **Selector**: Returns success on first child success (OR logic)
- **Sequence**: Returns failure on first child failure (AND logic)  
- **Parallel**: Runs multiple children, succeeds based on policy
- **Decorator**: Modifies child behavior (Inverter, Repeat, Timeout)
- **Condition**: Checks game state, never returns Running
- **Action**: Performs game action, can return Running until complete

### Hierarchical State Machine

```
CombatStateMachine
├── Idle
│   └── on: SeeEnemy → TransitionTo(Engage)
├── Engage
│   ├── on: TargetLost → TransitionTo(Search)
│   ├── on: HealthLow → TransitionTo(Retreat)
│   └── on: InAttackRange → TransitionTo(Attack)
├── Attack
│   ├── on: TargetDead → TransitionTo(Victory)
│   ├── on: TargetFled → TransitionTo(Chase)
│   └── on: AttackComplete → StayInState (loop)
├── Chase
│   └── on: InAttackRange → TransitionTo(Attack)
└── Retreat
    └── on: Safe → TransitionTo(Idle)
```

**Guidelines**:
- States handle entry/exit logic
- Transitions evaluated every update
- Use stack for state history (return to previous)
- Sub-state machines for complex state logic

### GOAP (Goal-Oriented Action Planning)

**When to Use**: Complex AI with many possible actions and dynamic goals (RPG NPCs, strategy games).

**Structure**:
```
Goals (weighted by priority):
├── StayAlive (priority: 100)
├── KillEnemy (priority: 80)
└── Patrol (priority: 10)

Actions (preconditions and effects):
├── MoveTo: precondition(nearTarget=false), effect(nearTarget=true)
├── Attack: precondition(nearTarget=true, hasWeapon=true), effect(enemyDead=true)
├── Heal: precondition(hasPotion=true, health<50%), effect(health=100%)
└── FindWeapon: precondition(hasWeapon=false), effect(hasWeapon=true)

Planner: A* search through action graph to satisfy top goal
```

## Standard Project Structure

```
game-project/
├── src/ai/
│   ├── core/
│   │   ├── BehaviorTree.hpp            ← Base node classes
│   │   ├── StateMachine.hpp            ← Hierarchical FSM
│   │   ├── Blackboard.hpp              ← Shared data store
│   │   └── Planner.hpp                 ← GOAP implementation
│   ├── behaviors/
│   │   ├── SelectorNode.cpp
│   │   ├── SequenceNode.cpp
│   │   ├── ParallelNode.cpp
│   │   └── DecoratorNodes.cpp
│   ├── actions/
│   │   ├── MoveAction.cpp              ← Navigation wrapper
│   │   ├── AttackAction.cpp
│   │   ├── FindTargetAction.cpp
│   │   └── FleeAction.cpp
│   ├── conditions/
│   │   ├── HasTargetCondition.cpp
│   │   ├── IsInRangeCondition.cpp
│   │   └── HealthCheckCondition.cpp
│   ├── pathfinding/
│   │   ├── AStar.hpp                   ← A* algorithm
│   │   ├── NavMesh.hpp                 ← Navigation mesh
│   │   ├── PathRequest.hpp             ← Async path query
│   │   └── PathSmoothing.cpp
│   └── perception/
│       ├── PerceptionSystem.cpp        ← Vision/hearing
│       ├── MemoryComponent.hpp         ← Last known positions
│       └── ThreatEvaluator.cpp
└── data/ai/
    ├── enemy_behavior_trees/           ← Serialized trees
    ├── npc_dialogue_states/
    └── navmesh_data/
```

## SOP (Standard Operating Procedure)

1. **AI Implementation Flow**: Define NPC goals and available actions → Choose architecture (BT for reactive, FSM for simple, GOAP for complex planning) → Implement core nodes/states → Wire into perception system → Test with debug visualization.
2. **Pathfinding Integration**: Request path through async API → Receive waypoint list → Follow with steering behaviors (seek, avoid) → Requery if blocked or target moves → Handle "path not found" gracefully (idle, request help).
3. **Behavior Tree Authoring**: Start with high-level selector ("Combat or Patrol?") → Break each branch into sequences of conditions + actions → Add decorators for timeouts/retries → Use blackboard for inter-node communication.

## Checklist

- [ ] All behavior tree nodes return explicit Success/Failure/Running
- [ ] State machine handles all possible transitions
- [ ] Pathfinding is async or time-sliced
- [ ] AI not updated every frame (use tick rates)
- [ ] Blackboard memory cleaned on AI reset
- [ ] Perception system respects physics/occlusion
- [ ] Multiple AIs don't use single shared state

## Best Practices

1. **Use blackboard for shared AI memory** — Store target references, last known positions, and working memory in a blackboard (key-value store). Nodes communicate via blackboard instead of direct references. Enables reuse of behavior subtrees.

2. **Implement steering behaviors for smooth movement** — Don't snap to path waypoints. Use seek, arrive, separation, and obstacle avoidance forces for natural movement. Blend multiple steering forces for complex navigation.

3. **Utility AI for fuzzy decisions** — When decisions aren't binary ("which target to attack?"), use utility scoring. Score each option based on distance, threat level, health, etc. Select highest score. More flexible than hardcoded priority.

4. **Debug visualization is essential** — Draw current state/behavior, target lines, path, and perception cones. AI bugs are hard to diagnose from behavior alone. Expose blackboard values in debug UI.

5. **LOD (Level of Detail) for AI** — Distant NPCs don't need complex AI. Reduce update frequency, simplify pathfinding, or use dumb behaviors for far-away entities. Resume full AI when player approaches.

## Anti-Patterns

1. **Polling every frame for all checks** — Checking "can I see player?" 60 times per second for 50 AI. Instead: use event-driven perception, spatial queries on change, or stagger update ticks across frames.

2. **Perfect AI knowledge** — AI with omniscience (knows player HP, exact position through walls). Instead: limit to perception cone, require line of sight, remember last known position, share knowledge between nearby AI.

3. **Monolithic AI Update function** — Single 500-line Update() handling everything. Instead: decompose into state behaviors, action subtrees, or system-based processing (separate movement, combat, perception systems).

4. **Synchronous pathfinding on main thread** — Calling A* on 1000x1000 grid in the middle of frame. Instead: use async path requests, time-sliced computation (limit nodes per frame), or flow fields for crowds.

5. **Hardcoding behavior in code** — C++ `if (health < 0.3) Flee()` scattered across source. Instead: data-drive behaviors (JSON/XML behavior trees). Designers can tweak without recompilation. Hot-reload for rapid iteration.

## Context Hints

1. **Behavior tree libraries**: C++ → BehaviorTree.CPP (popular, ROS integration); C# → Fluent Behavior Tree, PandaBT (Unity); JavaScript - behavior3js. Most implement the standard node types with visual editors.

2. **NavMesh vs Grid**: NavMesh (polygon-based) is better for 3D with arbitrary geometry — precise, handles convexity. Grid (tile-based) is simpler for 2D/top-down games — easier to implement, works with tilemaps.

3. **Path smoothing**: Raw A* output has sharp turns. Apply funnel algorithm for NavMesh or catmull-rom splines for grid paths. Agents follow smooth curves instead of zigzagging.

4. **Group AI / Formation movement**: Individual agent pathfinding causes bunching. Use flow fields for crowds, or formation offsets for squads. Leader-follower patterns maintain formation while navigating.

5. **Replanning strategies**: In GOAP, full replan every frame is expensive. Only replan when: world state changes significantly, current action fails, or periodic check (e.g., every 2 seconds). Cache valid plans.

## Integration Guide

### When This Skill Activates

| Context | Trigger | Application |
|---------|---------|-------------|
| Design | Designing NPC/Enemy AI | BT vs FSM vs GOAP architecture decision |
| Implementation | Writing AI behaviors | Node/state implementation patterns |
| Optimization | AI performance issues | Update throttling, batching strategies |

### Related Patterns

- **Game Architecture**: ECS integration for AI entities
- **Unity/C#**: Engine-specific AI implementations
- **Performance**: AI LOD, time-slicing techniques
- **Testing**: AI behavior validation approaches

## Evolution History

| Version | Date | Change |
|---------|------|--------|
| v1.0.0 | 2026-03-26 | Initial creation with behavior trees, state machines, GOAP, and pathfinding patterns |
