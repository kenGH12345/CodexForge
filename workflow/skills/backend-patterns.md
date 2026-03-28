---
name: backend-patterns
version: 1.0.0
type: domain-skill
domains: [architecture, backend, design-patterns]
dependencies: [api-design]
load_level: task
max_tokens: 1500
triggers:
  keywords: [backend, API design, database, service layer, repository pattern, caching, middleware]
  roles: [backend-developer, architect, developer]
description: "Backend architecture patterns, API design principles, and server-side best practices"
---

# Skill: backend-patterns

> **Type**: Domain Skill
> **Version**: 1.0.0
> **Description**: Backend architecture patterns, API design principles, and server-side best practices
> **Domains**: architecture, backend, design-patterns

---

## Rules

### R1: Layered Architecture (MANDATORY)
- **Separation of Concerns**: Each layer has a single responsibility
- **Dependency Direction**: Layers depend only on layers below them
- **Abstraction Boundaries**: Layers communicate through well-defined interfaces
- **Common Layers**: Controller/Handler → Service → Repository/DAO → Data Source

### R2: API Design Consistency
- **Resource-Based URLs**: Use nouns, not verbs (`/users` not `/getUsers`)
- **HTTP Methods Semantically**:
  - GET: Retrieve
  - POST: Create
  - PUT: Replace
  - PATCH: Partial update
  - DELETE: Remove
- **Consistent Response Format**: Standard structure for all endpoints
- **Proper Status Codes**: Use correct HTTP status codes (2xx, 4xx, 5xx)

### R3: Database Best Practices
- **Select Only Needed Data**: Never fetch all columns if not needed
- **Avoid N+1 Queries**: Use batch fetching and joins
- **Use Transactions**: Multi-step operations must be atomic
- **Proper Indexing**: Ensure queries use indexes for performance

### R4: Error Handling Strategy
- **Centralized Error Handling**: Single place for error processing
- **Consistent Error Format**: Same structure for all errors
- **No Internal Leaks**: Don't expose implementation details
- **Proper Logging**: Log full details for debugging

---

## SOP (Standard Operating Procedure)

### Phase 1: Architecture Design
1. **Identify Layers Needed**:
   - Presentation (Controller/Handler)
   - Business Logic (Service)
   - Data Access (Repository)
   - External Services (Client/Adapter)
2. **Define Data Flow**: Request → Controller → Service → Repository → Database
3. **Define Interfaces**: Each layer exposes methods, hides implementation
4. **Error Handling Strategy**: How errors propagate and are handled

### Phase 2: API Design
1. **Resource Identification**: What are the core entities?
2. **Endpoint Mapping**:
   ```
   GET    /api/resource          # List
   GET    /api/resource/:id      # Get one
   POST   /api/resource          # Create
   PUT    /api/resource/:id      # Update
   PATCH  /api/resource/:id      # Partial update
   DELETE /api/resource/:id      # Delete
   ```
3. **Response Format**:
   ```
   Success: { success: true, data: T, meta?: {} }
   Error:   { success: false, error: string, details?: {} }
   ```
4. **Validation Strategy**: Input validation location and approach

### Phase 3: Implementation
1. **Repository Layer**: Data access logic, query building
2. **Service Layer**: Business logic, orchestration
3. **Controller Layer**: Request/response handling, delegation
4. **Middleware**: Cross-cutting concerns (auth, logging, error handling)

### Phase 4: Optimization
1. **N+1 Detection**: Review for query loops
2. **Caching Strategy**: Where to cache, invalidation rules
3. **Rate Limiting**: Protect endpoints
4. **Monitoring**: Logging, metrics, alerting

---

## Checklist

### Architecture
- [ ] Clear separation of layers (Controller/Service/Repository)
- [ ] Each layer has single responsibility
- [ ] Dependencies flow in one direction
- [ ] Interfaces define layer boundaries
- [ ] Dependency injection used appropriately

### API Design
- [ ] Resource-based URLs (nouns, not verbs)
- [ ] Semantic HTTP methods used correctly
- [ ] Consistent response format (success/error)
- [ ] Proper HTTP status codes
- [ ] Pagination for list endpoints
- [ ] Filtering/sorting via query params

### Database
- [ ] Select only needed columns
- [ ] No N+1 query patterns
- [ ] Transactions for multi-step operations
- [ ] Proper error handling for DB failures
- [ ] Connection pooling configured

### Error Handling
- [ ] Centralized error handling
- [ ] Consistent error response format
- [ ] No stack traces or internal details exposed
- [ ] Errors logged with full context
- [ ] Different error types handled appropriately

### Performance
- [ ] Caching strategy defined
- [ ] Rate limiting implemented
- [ ] Expensive operations optimized
- [ ] Lazy loading where appropriate

---

## Best Practices

### 1. Repository Pattern
Abstract data access:
```
Repository Interface
  ├─ findById(id)
  ├─ findAll(filters)
  ├─ create(data)
  ├─ update(id, data)
  └─ delete(id)

Implementation: SupabaseRepository, PostgreSQLRepository, MockRepository
```
Benefits: Swappable implementations, testable, single data access location

### 2. Service Layer Pattern
Encapsulate business logic:
```
Service
  ├─ validateBusinessRules(data)
  ├─ orchestrateOperations()
  ├─ applyPolicies()
  └─ coordinateRepositories()
```
Benefits: Reusable business logic, testable, clear separation

### 3. Dependency Injection
Don't create dependencies, receive them:
```
// Good: Dependencies injected
class UserService {
  constructor(userRepo, emailService) {
    this.userRepo = userRepo
    this.emailService = emailService
  }
}

// Bad: Dependencies created internally
class UserService {
  constructor() {
    this.userRepo = new UserRepository() // Tight coupling
  }
}
```

### 4. Defensive Programming
```
// Good: Validate inputs
function processOrder(order) {
  if (!order || !order.items || order.items.length === 0) {
    throw new ValidationError('Invalid order')
  }
  // ...
}

// Good: Handle errors
try {
  const result = await riskyOperation()
  return result
} catch (error) {
  logger.error('Operation failed', error)
  throw new ServiceError('Unable to process request')
}
```

### 5. Consistency Over Novelty
- Use consistent patterns across the codebase
- Follow established conventions
- Introduce new patterns deliberately, not ad-hoc

---

## Anti-Patterns

| ❌ Anti-Pattern | ✅ Correct Approach |
|----------------|---------------------|
| Business logic in controllers | Business logic in service layer |
| Direct DB access everywhere | Repository pattern, centralized access |
| N+1 query loops | Batch fetching, eager loading |
| Different error formats per endpoint | Consistent error response structure |
| Exposing internal errors to clients | Generic client messages, detailed logs |
| Tight coupling between layers | Dependency injection, interfaces |
| No transaction boundaries | Transactions for multi-step operations |
| `SELECT *` queries | Select only needed columns |

---

## Context Hints

- **When designing APIs**: Start with resources, use HTTP methods semantically
- **When accessing data**: Repository pattern provides flexibility and testability
- **When implementing features**: Business logic belongs in service layer
- **When handling errors**: Consistency and safety over convenience

---

## Evolution History

| Version | Date | Change |
|---------|------|--------|
| v1.0.0 | 2026-03-26 | Initial creation based on ECC backend-patterns, generalized for all tech stacks |
